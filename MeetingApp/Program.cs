using System.Diagnostics;
using DotNetEnv;
using MeetingApp.Hubs;
using MeetingApp.Services;
using Microsoft.AspNetCore.HttpOverrides;

// Load .env into environment variables (no-op if file is absent)
Env.TraversePath().Load();

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
});

builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 52_428_800; // 50 MB
});

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
});

// GoogleDriveService: only registered when credentials are present.
if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("GOOGLE_CREDENTIALS_JSON_B64")))
    builder.Services.AddSingleton<GoogleDriveService>();

// UploadLogger: always registered; internally respects UPLOAD_LOG_ENABLED flag (no-op when off).
builder.Services.AddSingleton<UploadLogger>();

var app = builder.Build();

app.UseForwardedHeaders();
app.UseStaticFiles();
app.UseCors();
app.MapHub<MeetingHub>("/meetingHub");

// ── File upload endpoint ──────────────────────────────────────────────────────
app.MapPost("/api/upload", async (
    HttpRequest request,
    IWebHostEnvironment env,
    IServiceProvider sp) =>
{
    // Optional services resolved at runtime — GetService<T> returns null when not registered.
    var driveService = sp.GetService<GoogleDriveService>();
    var uploadLogger = sp.GetRequiredService<UploadLogger>(); // always registered
    var sw = Stopwatch.StartNew();

    // ── Capture request headers for logging ───────────────────────────────────
    var headers = request.Headers
        .Where(h => !h.Key.StartsWith(':'))
        .ToDictionary(h => h.Key, h => h.Value.ToString());

    // ── Validation ────────────────────────────────────────────────────────────
    if (!request.HasFormContentType)
    {
        sw.Stop();
        await LogAsync(uploadLogger, sw.ElapsedMilliseconds,
            BuildRequestLog("POST", request, headers, roomCode: "", file: null),
            new UploadResponseLog { StatusCode = 400, Error = "Expected multipart/form-data" });
        return Results.BadRequest("Expected multipart/form-data");
    }

    var form     = await request.ReadFormAsync();
    var roomCode = form["roomCode"].ToString().ToUpperInvariant();
    var file     = form.Files.GetFile("file");

    var fileLog = file is null ? null : new FileLog
    {
        Name        = file.FileName,
        SizeBytes   = file.Length,
        ContentType = file.ContentType
    };

    if (file == null || file.Length == 0)
    {
        sw.Stop();
        await LogAsync(uploadLogger, sw.ElapsedMilliseconds,
            BuildRequestLog("POST", request, headers, roomCode, fileLog),
            new UploadResponseLog { StatusCode = 400, Error = "No file provided" });
        return Results.BadRequest("No file provided");
    }

    if (file.Length > 52_428_800)
    {
        sw.Stop();
        await LogAsync(uploadLogger, sw.ElapsedMilliseconds,
            BuildRequestLog("POST", request, headers, roomCode, fileLog),
            new UploadResponseLog { StatusCode = 400, Error = "File exceeds 50 MB limit" });
        return Results.BadRequest("File exceeds 50 MB limit");
    }

    if (string.IsNullOrWhiteSpace(roomCode))
    {
        sw.Stop();
        await LogAsync(uploadLogger, sw.ElapsedMilliseconds,
            BuildRequestLog("POST", request, headers, roomCode, fileLog),
            new UploadResponseLog { StatusCode = 400, Error = "roomCode is required" });
        return Results.BadRequest("roomCode is required");
    }

    // ── Save to local disk ────────────────────────────────────────────────────
    var uploadDir = Path.Combine(env.WebRootPath, "uploads", roomCode);
    Directory.CreateDirectory(uploadDir);

    var safeFileName = Path.GetFileName(file.FileName);
    safeFileName = string.Concat(safeFileName.Split(Path.GetInvalidFileNameChars()));
    var uniqueName = $"{Guid.NewGuid():N}_{safeFileName}";
    var filePath   = Path.Combine(uploadDir, uniqueName);

    await using var diskStream = File.Create(filePath);
    await file.CopyToAsync(diskStream);
    await diskStream.DisposeAsync();

    var fileUrl      = $"/uploads/{roomCode}/{uniqueName}";
    var reqLog       = BuildRequestLog("POST", request, headers, roomCode, fileLog);

    // ── Upload to Google Drive (optional) ─────────────────────────────────────
    string?   driveFileId  = null;
    DriveLog? driveLog     = null;

    if (driveService is not null)
    {
        // Use the file's actual content-type so Drive API gets the correct mimeType.
        var mimeType = file.ContentType is { Length: > 0 } ct ? ct : "application/octet-stream";

        try
        {
            await using var driveStream = File.OpenRead(filePath);
            var bytesSentProgress = new Progress<long>(bytes =>
                app.Logger.LogDebug("Drive progress: {Bytes} bytes sent", bytes));

            var driveResult = await driveService.UploadVideoAsync(
                driveStream,
                uniqueName,
                mimeType,
                bytesSentProgress,
                request.HttpContext.RequestAborted);

            driveFileId = driveResult.Id;

            driveLog = new DriveLog
            {
                Request = new DriveRequestLog
                {
                    MetadataName     = driveResult.Snapshot.MetadataName,
                    MetadataMimeType = driveResult.Snapshot.MetadataMimeType,
                    MetadataParents  = driveResult.Snapshot.MetadataParents,
                    UploadType       = driveResult.Snapshot.UploadType,
                    ContentType      = driveResult.Snapshot.ContentType,
                    Fields           = driveResult.Snapshot.Fields
                },
                Response = new DriveResponseLog
                {
                    Id       = driveResult.Id,
                    Name     = driveResult.Name,
                    MimeType = driveResult.MimeType
                }
            };
        }
        catch (Exception ex)
        {
            app.Logger.LogError(ex, "Drive upload error for {File}", uniqueName);
            driveLog = new DriveLog
            {
                Request = new DriveRequestLog
                {
                    MetadataName     = uniqueName,
                    MetadataMimeType = mimeType,
                    MetadataParents  = [Environment.GetEnvironmentVariable("DRIVE_FOLDER_ID") ?? ""],
                    UploadType       = "unknown",
                    ContentType      = mimeType,
                    Fields           = "id,name,mimeType"
                },
                Error = ex.Message
            };
        }
    }

    // ── Build success response body ───────────────────────────────────────────
    var responseBody = new { fileName = safeFileName, fileUrl, fileSize = file.Length, driveFileId };

    sw.Stop();
    await LogAsync(uploadLogger, sw.ElapsedMilliseconds, reqLog, new UploadResponseLog
    {
        StatusCode = 200,
        Body       = responseBody,
        Drive      = driveLog
    });

    return Results.Ok(responseBody);
});

// ── ICE / TURN config ─────────────────────────────────────────────────────────
app.MapGet("/api/config", (IConfiguration cfg) =>
{
    var domain     = cfg["TURN_DOMAIN"]     ?? "";
    var user       = cfg["TURN_USER"]       ?? "";
    var credential = cfg["TURN_CREDENTIAL"] ?? "";

    var iceServers = new List<object>
    {
        new { urls = new[] { "stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302" } }
    };

    if (!string.IsNullOrEmpty(domain))
    {
        iceServers.Add(new { urls = $"turn:{domain}:3478",  username = user, credential });
        iceServers.Add(new { urls = $"turns:{domain}:5349", username = user, credential });
    }

    return Results.Ok(new { iceServers });
});

app.MapFallbackToFile("index.html");

app.Run();

// ── Helpers ───────────────────────────────────────────────────────────────────
static UploadRequestLog BuildRequestLog(
    string method,
    HttpRequest request,
    Dictionary<string, string> headers,
    string roomCode,
    FileLog? file)
{
    return new UploadRequestLog
    {
        Method  = method,
        Url     = $"{request.Scheme}://{request.Host}{request.Path}{request.QueryString}",
        Headers = headers,
        Body    = new UploadRequestBody { RoomCode = roomCode, File = file }
    };
}

static Task LogAsync(UploadLogger? logger, long durationMs, UploadRequestLog req, UploadResponseLog res)
{
    if (logger is null) return Task.CompletedTask;
    return logger.WriteAsync(new UploadLogEntry
    {
        Timestamp  = DateTime.UtcNow.ToString("O"),
        DurationMs = durationMs,
        Request    = req,
        Response   = res
    });
}
