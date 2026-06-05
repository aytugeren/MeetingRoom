namespace MeetingApp.Models;

public class ChatMessage
{
    public string SenderId { get; set; } = "";
    public string SenderName { get; set; } = "";
    public string Message { get; set; } = "";
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public bool IsFile { get; set; } = false;
    public string? FileName { get; set; }
    public string? FileUrl { get; set; }
    public long? FileSize { get; set; }
}
