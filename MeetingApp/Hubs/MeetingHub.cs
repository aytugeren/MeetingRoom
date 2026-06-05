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
        lock (room.Lock)
            history = room.Messages.ToList();

        if (history.Count > 0)
            await Clients.Caller.SendAsync("ChatHistory", history);

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
        lock (room.Lock)
        {
            room.Participants.TryGetValue(connectionId, out participant);
            room.Participants.Remove(connectionId);

            if (room.Participants.Count == 0)
                Rooms.TryRemove(roomCode, out _);
        }

        await Groups.RemoveFromGroupAsync(connectionId, roomCode);

        if (participant != null)
            await Clients.Group(roomCode).SendAsync("UserLeft", connectionId, participant.UserName);
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
