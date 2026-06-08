using System.Text.Json;
using System.Text.Json.Serialization;

namespace MeetingApp.Services;

// ── Log entry models ──────────────────────────────────────────────────────────

public sealed class UploadLogEntry
{
    public string Timestamp   { get; init; } = string.Empty;
    public long   DurationMs  { get; init; }
    public UploadRequestLog  Request  { get; init; } = new();
    public UploadResponseLog Response { get; init; } = new();
}

public sealed class UploadRequestLog
{
    public string Method  { get; init; } = string.Empty;
    public string Url     { get; init; } = string.Empty;
    public Dictionary<string, string> Headers { get; init; } = [];
    public UploadRequestBody Body { get; init; } = new();
}

public sealed class UploadRequestBody
{
    public string   RoomCode { get; init; } = string.Empty;
    public FileLog? File     { get; init; }
}

public sealed class FileLog
{
    public string Name        { get; init; } = string.Empty;
    public long   SizeBytes   { get; init; }
    public string ContentType { get; init; } = string.Empty;
}

public sealed class UploadResponseLog
{
    public int     StatusCode { get; init; }
    public object? Body       { get; init; }
    public DriveLog? Drive    { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error      { get; init; }
}

public sealed class DriveLog
{
    public DriveRequestLog  Request  { get; init; } = new();
    public DriveResponseLog? Response { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }
}

public sealed class DriveRequestLog
{
    // Metadata JSON body sent to Drive API
    public string   MetadataName     { get; init; } = string.Empty;
    public string   MetadataMimeType { get; init; } = string.Empty;
    public string[] MetadataParents  { get; init; } = [];
    // Upload parameters
    public string UploadType  { get; init; } = string.Empty;
    public string ContentType { get; init; } = string.Empty;
    public string Fields      { get; init; } = string.Empty;
}

public sealed class DriveResponseLog
{
    public string? Id       { get; init; }
    public string? Name     { get; init; }
    public string? MimeType { get; init; }
}

// ── Logger service ────────────────────────────────────────────────────────────

public sealed class UploadLogger
{
    private readonly string? _logPath;   // null → logging disabled
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions _opts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // Always registered in DI; respects UPLOAD_LOG_ENABLED internally.
    public UploadLogger(IConfiguration config)
    {
        if (config["UPLOAD_LOG_ENABLED"] != "true") return;

        _logPath = config["UPLOAD_LOG_PATH"] ?? "./logs/upload-requests.json";
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_logPath))!);
    }

    // No-op when logging is disabled.
    public async Task WriteAsync(UploadLogEntry entry)
    {
        if (_logPath is null) return;

        var line = JsonSerializer.Serialize(entry, _opts);
        await _lock.WaitAsync();
        try
        {
            await File.AppendAllTextAsync(_logPath, line + Environment.NewLine + "---" + Environment.NewLine);
        }
        finally
        {
            _lock.Release();
        }
    }
}
