namespace MeetingApp.Models;

public class Room
{
    public string Code { get; set; } = "";
    public Dictionary<string, Participant> Participants { get; set; } = new();
    public List<ChatMessage> Messages { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public object Lock { get; } = new();

    // YouTube background music state
    public string? YoutubeVideoId { get; set; }
    public string? YoutubeStarterName { get; set; }
    public DateTime? YoutubeStartedAt { get; set; }
}
