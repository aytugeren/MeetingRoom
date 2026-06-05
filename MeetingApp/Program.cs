using MeetingApp.Hubs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 52_428_800; // 50 MB
});

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
});

var app = builder.Build();

app.UseStaticFiles();
app.UseCors();
app.MapHub<MeetingHub>("/meetingHub");

// File upload endpoint
app.MapPost("/api/upload", async (HttpRequest request, IWebHostEnvironment env) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest("Expected multipart/form-data");

    var form = await request.ReadFormAsync();
    var roomCode = form["roomCode"].ToString().ToUpperInvariant();
    var file = form.Files.GetFile("file");

    if (file == null || file.Length == 0)
        return Results.BadRequest("No file provided");

    if (file.Length > 52_428_800)
        return Results.BadRequest("File exceeds 50 MB limit");

    if (string.IsNullOrWhiteSpace(roomCode))
        return Results.BadRequest("roomCode is required");

    var uploadDir = Path.Combine(env.WebRootPath, "uploads", roomCode);
    Directory.CreateDirectory(uploadDir);

    // Sanitize filename and avoid collisions
    var safeFileName = Path.GetFileName(file.FileName);
    safeFileName = string.Concat(safeFileName.Split(Path.GetInvalidFileNameChars()));
    var uniqueName = $"{Guid.NewGuid():N}_{safeFileName}";
    var filePath = Path.Combine(uploadDir, uniqueName);

    await using var stream = File.Create(filePath);
    await file.CopyToAsync(stream);

    var fileUrl = $"/uploads/{roomCode}/{uniqueName}";
    return Results.Ok(new { fileName = safeFileName, fileUrl, fileSize = file.Length });
});

// Fallback: serve index.html for unknown routes (SPA style)
app.MapFallbackToFile("index.html");

app.Run();
