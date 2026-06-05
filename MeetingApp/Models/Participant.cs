namespace MeetingApp.Models;

public class Participant
{
    public string ConnectionId { get; set; } = "";
    public string UserId { get; set; } = "";
    public string UserName { get; set; } = "";
    public bool IsAudioOn { get; set; } = true;
    public bool IsVideoOn { get; set; } = true;
    public bool IsSharingScreen { get; set; } = false;
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}
