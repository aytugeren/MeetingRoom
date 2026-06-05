# MeetingRoom

A full-featured, free, open-source real-time video meeting application built with
**ASP.NET Core 9**, **SignalR**, **WebRTC**, and vanilla JavaScript.

## Quick Start

```bash
cd MeetingApp
dotnet run
```

Then open **http://localhost:5000** in Chrome or Edge.

## Features

| Feature | Details |
|---|---|
| Video & Audio | WebRTC peer-to-peer, mute/camera toggle |
| Screen Share | `getDisplayMedia`, peer-to-peer video track replacement |
| Remote Control | Browser-level mouse/keyboard forwarding via SignalR (see limitation below) |
| Chat | Real-time via SignalR, unread badge |
| File Sharing | POST `/api/upload`, max 50 MB, stored in `wwwroot/uploads/{roomCode}/` |
| Rooms | In-memory, random 6-char code, no database |

## File Upload Storage

Uploaded files are stored at:

```
MeetingApp/wwwroot/uploads/{ROOM_CODE}/{uuid}_{filename}
```

This directory is served as static files and is excluded from git via `.gitignore`.
**Restart clears all in-memory room state** (participants, chat), but uploaded files persist on disk.

## Remote Control — Browser Limitation

True OS-level remote control (moving the remote machine's cursor) is **not possible from a browser**.

What this app does:
- The viewer sends `mousemove`, `click`, and `keydown` events to the sharer via SignalR.
- The sharer's browser dispatches **synthetic DOM events** at the corresponding coordinates.
- This works for web-based content in the shared tab/window, but has no effect on native OS UI.

This is clearly documented in the UI with a "Remote Control Active" overlay on both sides.

## STUN / TURN Configuration

The app uses Google's public STUN servers (free, no sign-up):

```
stun:stun.l.google.com:19302
stun:stun1.l.google.com:19302
```

For **production / cross-network use**, add a self-hosted [Coturn](https://github.com/coturn/coturn) TURN server.
Stub config already in `wwwroot/js/app.js`:

```js
// In app.js, ICE_SERVERS array:
{ urls: 'turn:your-turn-server.example.com:3478', username: 'user', credential: 'pass' }
```

### Coturn Quick Setup (Ubuntu)

```bash
sudo apt install coturn
# Edit /etc/turnserver.conf:
#   listening-port=3478
#   realm=your-domain.com
#   user=user:pass
#   lt-cred-mech
sudo systemctl enable coturn && sudo systemctl start coturn
```

## NuGet Packages

No extra NuGet packages required — SignalR is included in `Microsoft.NET.Sdk.Web` for .NET 9.

The only CDN dependencies (loaded in HTML):
- [Tailwind CSS](https://tailwindcss.com) — MIT
- [Microsoft SignalR JS client](https://www.npmjs.com/package/@microsoft/signalr) — MIT

## Browser Compatibility

Chrome 80+ and Edge 80+ required (WebRTC + `getDisplayMedia`).
Firefox works for video/audio but `getDisplayMedia` screen sharing may have limitations.

## Project Structure

```
MeetingApp/
  Program.cs               SignalR + file upload endpoint
  Hubs/MeetingHub.cs       All SignalR hub methods
  Models/                  Room, Participant, ChatMessage
  wwwroot/
    index.html             Landing / create+join room
    meeting.html           Meeting room UI
    js/app.js              WebRTC + SignalR client + UI
    css/style.css          Custom dark-theme styles
    uploads/               File uploads (gitignored)
```
