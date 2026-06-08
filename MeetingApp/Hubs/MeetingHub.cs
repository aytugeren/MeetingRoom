using Microsoft.AspNetCore.SignalR;
using MeetingApp.Models;
using System.Collections.Concurrent;

namespace MeetingApp.Hubs;

public class MeetingHub : Hub
{
    private static readonly ConcurrentDictionary<string, Room> Rooms = new();

    // connectionId → (roomCode, userId)
    private static readonly ConcurrentDictionary<string, (string RoomCode, string UserId)> ConnectionMap = new();

    // ─── Room helpers ────────────────────────────────────────────────────────

    private Room GetOrCreateRoom(string roomCode)
        => Rooms.GetOrAdd(roomCode, code => new Room { Code = code });

    // ─── Hub methods ─────────────────────────────────────────────────────────

    public async Task JoinRoom(string roomCode, string userName)
    {
        roomCode = roomCode.ToUpperInvariant();
        var userId = Context.ConnectionId;
        var room = GetOrCreateRoom(roomCode);

        var participant = new Participant
        {
            ConnectionId = Context.ConnectionId,
            UserId = userId,
            UserName = userName
        };

        lock (room.Lock)
            room.Participants[userId] = participant;

        ConnectionMap[Context.ConnectionId] = (roomCode, userId);

        await Groups.AddToGroupAsync(Context.ConnectionId, roomCode);

        // Send existing participants to the joiner
        var existing = room.Participants.Values
            .Where(p => p.UserId != userId)
            .Select(p => new { p.UserId, p.UserName, p.IsAudioOn, p.IsVideoOn, p.IsSharingScreen })
            .ToList();

        await Clients.Caller.SendAsync("ExistingParticipants", existing);

        // Send chat history to the joiner
        List<ChatMessage> history;
        string? ytVideoId;
        string? ytStarterName;
        double ytElapsed = 0;
        lock (room.Lock)
        {
            history = room.Messages.ToList();
            ytVideoId = room.YoutubeVideoId;
            ytStarterName = room.YoutubeStarterName;
            if (room.YoutubeStartedAt.HasValue)
                ytElapsed = (DateTime.UtcNow - room.YoutubeStartedAt.Value).TotalSeconds;
        }

        if (history.Count > 0)
            await Clients.Caller.SendAsync("ChatHistory", history);

        if (ytVideoId != null)
            await Clients.Caller.SendAsync("ReceiveYouTubePlay", ytVideoId, ytStarterName ?? "", ytElapsed);

        // If someone is already recording, inform the new joiner
        string? activeRecorderName;
        lock (room.Lock) { activeRecorderName = room.RecorderName; }
        if (activeRecorderName != null)
            await Clients.Caller.SendAsync("RecordingStarted", activeRecorderName);

        // Notify others
        await Clients.OthersInGroup(roomCode).SendAsync("UserJoined", userId, userName);
    }

    public async Task LeaveRoom(string roomCode)
    {
        roomCode = roomCode.ToUpperInvariant();
        await HandleLeave(roomCode, Context.ConnectionId);
    }

    public async Task SendMessage(string roomCode, string message)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;
        if (!room.Participants.TryGetValue(Context.ConnectionId, out var sender)) return;

        var msg = new ChatMessage
        {
            SenderId = sender.UserId,
            SenderName = sender.UserName,
            Message = message,
            Timestamp = DateTime.UtcNow
        };

        lock (room.Lock)
            room.Messages.Add(msg);

        await Clients.Group(roomCode).SendAsync("ReceiveMessage",
            sender.UserId, sender.UserName, message, msg.Timestamp);
    }

    public async Task UpdateMediaState(string roomCode, bool audioOn, bool videoOn)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;
        if (!room.Participants.TryGetValue(Context.ConnectionId, out var p)) return;

        p.IsAudioOn = audioOn;
        p.IsVideoOn = videoOn;

        await Clients.OthersInGroup(roomCode).SendAsync("ParticipantMediaChanged",
            Context.ConnectionId, audioOn, videoOn, p.IsSharingScreen);
    }

    public async Task UpdateScreenShareState(string roomCode, bool isSharingScreen)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;
        if (!room.Participants.TryGetValue(Context.ConnectionId, out var p)) return;

        p.IsSharingScreen = isSharingScreen;

        await Clients.OthersInGroup(roomCode).SendAsync("ParticipantMediaChanged",
            Context.ConnectionId, p.IsAudioOn, p.IsVideoOn, isSharingScreen);
    }

    // ─── Recording ───────────────────────────────────────────────────────────

    public async Task StartRecording(string roomCode)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;
        if (!room.Participants.TryGetValue(Context.ConnectionId, out var p)) return;

        lock (room.Lock)
        {
            if (room.RecorderConnectionId != null)
                throw new HubException("Zaten biri kayıt alıyor.");
            room.RecorderConnectionId = Context.ConnectionId;
            room.RecorderName         = p.UserName;
        }

        // Notify everyone else — caller handles its own UI after invoke resolves
        await Clients.OthersInGroup(roomCode).SendAsync("RecordingStarted", p.UserName);
    }

    public async Task StopRecording(string roomCode)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;

        lock (room.Lock)
        {
            if (room.RecorderConnectionId != Context.ConnectionId) return;
            room.RecorderConnectionId = null;
            room.RecorderName         = null;
        }

        await Clients.OthersInGroup(roomCode).SendAsync("RecordingStopped");
    }

    // ─── WebRTC signaling ────────────────────────────────────────────────────

    public async Task SendOffer(string targetId, object offer)
        => await Clients.Client(targetId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);

    public async Task SendAnswer(string targetId, object answer)
        => await Clients.Client(targetId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);

    public async Task SendIceCandidate(string targetId, object candidate)
        => await Clients.Client(targetId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);

    // ─── Remote control ──────────────────────────────────────────────────────

    public async Task RequestRemoteControl(string targetId)
    {
        if (!TryGetParticipant(Context.ConnectionId, out _, out var requester)) return;
        await Clients.Client(targetId).SendAsync("RemoteControlRequested",
            Context.ConnectionId, requester!.UserName);
    }

    public async Task AcceptRemoteControl(string requesterId)
        => await Clients.Client(requesterId).SendAsync("RemoteControlAccepted");

    public async Task DenyRemoteControl(string requesterId)
        => await Clients.Client(requesterId).SendAsync("RemoteControlDenied");

    public async Task SendRemoteEvent(string targetId, string eventType, object eventData)
        => await Clients.Client(targetId).SendAsync("ReceiveRemoteEvent", eventType, eventData);

    public async Task RevokeRemoteControl(string controllerId)
        => await Clients.Client(controllerId).SendAsync("RemoteControlRevoked");

    // ─── File sharing ────────────────────────────────────────────────────────

    public async Task NotifyFileShared(string roomCode, string fileName, string fileUrl, long fileSize)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;
        if (!room.Participants.TryGetValue(Context.ConnectionId, out var sender)) return;

        var msg = new ChatMessage
        {
            SenderId = sender.UserId,
            SenderName = sender.UserName,
            Message = $"Shared a file: {fileName}",
            Timestamp = DateTime.UtcNow,
            IsFile = true,
            FileName = fileName,
            FileUrl = fileUrl,
            FileSize = fileSize
        };

        lock (room.Lock)
            room.Messages.Add(msg);

        await Clients.Group(roomCode).SendAsync("FileShared",
            sender.UserName, fileName, fileUrl, fileSize, msg.Timestamp);
    }

    // ─── YouTube background music ────────────────────────────────────────────

    public async Task PlayYouTube(string roomCode, string videoId)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;
        if (!room.Participants.TryGetValue(Context.ConnectionId, out var sender)) return;

        lock (room.Lock)
        {
            room.YoutubeVideoId = videoId;
            room.YoutubeStarterName = sender.UserName;
            room.YoutubeStartedAt = DateTime.UtcNow;
        }

        // All clients start from 0 seconds — elapsed is 0 at broadcast time
        await Clients.Group(roomCode).SendAsync("ReceiveYouTubePlay", videoId, sender.UserName, 0.0);
    }

    public async Task StopYouTube(string roomCode)
    {
        roomCode = roomCode.ToUpperInvariant();
        if (!Rooms.TryGetValue(roomCode, out var room)) return;

        lock (room.Lock)
        {
            room.YoutubeVideoId = null;
            room.YoutubeStarterName = null;
            room.YoutubeStartedAt = null;
        }

        await Clients.Group(roomCode).SendAsync("ReceiveYouTubeStop");
    }

    // ─── Disconnect ──────────────────────────────────────────────────────────

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (ConnectionMap.TryRemove(Context.ConnectionId, out var info))
            await HandleLeave(info.RoomCode, Context.ConnectionId);

        await base.OnDisconnectedAsync(exception);
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    private async Task HandleLeave(string roomCode, string connectionId)
    {
        if (!Rooms.TryGetValue(roomCode, out var room)) return;

        Participant? participant = null;
        bool wasRecording = false;
        lock (room.Lock)
        {
            room.Participants.TryGetValue(connectionId, out participant);
            room.Participants.Remove(connectionId);

            if (room.RecorderConnectionId == connectionId)
            {
                room.RecorderConnectionId = null;
                room.RecorderName         = null;
                wasRecording              = true;
            }

            if (room.Participants.Count == 0)
                Rooms.TryRemove(roomCode, out _);
        }

        await Groups.RemoveFromGroupAsync(connectionId, roomCode);

        if (participant != null)
            await Clients.Group(roomCode).SendAsync("UserLeft", connectionId, participant.UserName);

        if (wasRecording)
            await Clients.Group(roomCode).SendAsync("RecordingStopped");
    }

    private bool TryGetParticipant(string connectionId,
        out string? roomCode, out Participant? participant)
    {
        roomCode = null;
        participant = null;

        if (!ConnectionMap.TryGetValue(connectionId, out var info)) return false;
        if (!Rooms.TryGetValue(info.RoomCode, out var room)) return false;
        if (!room.Participants.TryGetValue(connectionId, out participant)) return false;

        roomCode = info.RoomCode;
        return true;
    }
}
