using Google.Apis.Auth.OAuth2;
using Google.Apis.Drive.v3;
using Google.Apis.Services;
using Google.Apis.Upload;
using DriveFile = Google.Apis.Drive.v3.Data.File;

namespace MeetingApp.Services;

public sealed class DriveUploadResult
{
    public string Id       { get; init; } = string.Empty;
    public string Name     { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;

    // Full snapshot of what was sent to the Drive API (for logging)
    public DriveApiSnapshot Snapshot { get; init; } = new();
}

public sealed class DriveApiSnapshot
{
    public string   MetadataName     { get; init; } = string.Empty;
    public string   MetadataMimeType { get; init; } = string.Empty;
    public string[] MetadataParents  { get; init; } = [];
    public string   UploadType       { get; init; } = string.Empty;
    public string   ContentType      { get; init; } = string.Empty;
    public string   Fields           { get; init; } = string.Empty;
}

public sealed class GoogleDriveService
{
    private readonly DriveService _drive;
    private readonly string _folderId;
    private readonly ILogger<GoogleDriveService> _logger;

    public GoogleDriveService(IConfiguration config, ILogger<GoogleDriveService> logger)
    {
        _logger = logger;

        var credB64 = config["GOOGLE_CREDENTIALS_JSON_B64"]
            ?? throw new InvalidOperationException("GOOGLE_CREDENTIALS_JSON_B64 is not set.");

        var credJson = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(credB64));

        _folderId = config["DRIVE_FOLDER_ID"]
            ?? throw new InvalidOperationException("DRIVE_FOLDER_ID is not set.");

        var credential = GoogleCredential
            .FromJson(credJson)
            .CreateScoped(DriveService.Scope.DriveFile);

        _drive = new DriveService(new BaseClientService.Initializer
        {
            HttpClientInitializer = credential,
            ApplicationName = "MeetingRoom"
        });
    }

    public async Task<DriveUploadResult> UploadVideoAsync(
        Stream fileStream,
        string fileName,
        string mimeType,
        IProgress<long>? progress = null,
        CancellationToken cancellationToken = default)
    {
        const string fields = "id,name,mimeType";

        var metadata = new DriveFile
        {
            Name     = fileName,
            MimeType = mimeType,
            Parents  = [_folderId]
        };

        var request = _drive.Files.Create(metadata, fileStream, mimeType);
        request.Fields = fields;

        // Determine whether the SDK will use multipart or resumable upload.
        // The library switches to resumable automatically for streams > 5 MB,
        // but we can read the UploadType after the fact from the request URI.
        var snapshot = new DriveApiSnapshot
        {
            MetadataName     = fileName,
            MetadataMimeType = mimeType,
            MetadataParents  = [_folderId],
            ContentType      = mimeType,
            Fields           = fields,
            UploadType       = fileStream.CanSeek && fileStream.Length <= 5 * 1024 * 1024
                                   ? "multipart"
                                   : "resumable"
        };

        request.ProgressChanged += p =>
        {
            if (p.Status == UploadStatus.Uploading)
            {
                progress?.Report(p.BytesSent);
                _logger.LogDebug("Drive upload {File}: {Bytes} bytes sent", fileName, p.BytesSent);
            }
            else if (p.Status == UploadStatus.Failed)
            {
                _logger.LogError(p.Exception, "Drive upload failed for {File}", fileName);
            }
        };

        request.ResponseReceived += f =>
            _logger.LogInformation(
                "Drive upload completed — id={Id} name={Name} mimeType={Mime}",
                f.Id, f.Name, f.MimeType);

        var result = await request.UploadAsync(cancellationToken);

        if (result.Status == UploadStatus.Failed)
            throw new IOException(
                $"Google Drive upload failed: {result.Exception?.Message}", result.Exception);

        var uploaded = request.ResponseBody
            ?? throw new InvalidOperationException("Drive API returned no response body.");

        return new DriveUploadResult
        {
            Id       = uploaded.Id,
            Name     = uploaded.Name,
            MimeType = uploaded.MimeType,
            Snapshot = snapshot
        };
    }
}
