/**
 * server/index.js — Watch Party v2
 *
 * BUG FIXES:
 *  1. Room join: rooms now created on socket join-room with isCreating flag.
 *     REST POST /api/rooms just generates an ID — no room stored.
 *     Clients skip REST validation and go straight to socket.
 *  2. Screen share: server just relays signals — race condition is fixed client-side.
 *
 * NEW: Voice chat signaling (WebRTC mesh for audio)
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  createRoom, getRoom, joinRoom, leaveRoom,
  updateVideo, updatePlayback, setReady,
  joinVoice, leaveVoice, setMuted,
} = require('./rooms');

const app    = express();
const isProd = process.env.NODE_ENV === 'production';

if (isProd) app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── REST ──────────────────────────────────────────────────────────────────────
// Only generates a room ID — actual room is created by the socket join-room event.
app.post('/api/rooms', (req, res) => {
  const roomId = uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
  res.json({ roomId });
});

if (isProd) {
  app.get('*', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeUsers(room) {
  // Convert voiceUsers Set to array for JSON serialisation
  return room.users.map((u) => ({ ...u }));
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── join-room ──────────────────────────────────────────────────────────────
  /**
   * FIX: isCreating flag tells the server whether to create or join.
   * If isCreating=false and room doesn't exist → send error.
   * This eliminates the REST GET /api/rooms/:id race condition entirely.
   */
  socket.on('join-room', ({ roomId, userName, isCreating }) => {
    if (!roomId || !userName) return;
    roomId   = roomId.trim().toUpperCase();
    userName = userName.trim().slice(0, 30);

    let room = getRoom(roomId);

    if (!room) {
      if (!isCreating) {
        // Room genuinely doesn't exist
        socket.emit('error-msg', { message: `Room "${roomId}" not found. Check the ID and try again.` });
        return;
      }
      // Create new room
      room = createRoom(roomId, socket.id, userName);
    } else {
      // Join existing room
      room = joinRoom(roomId, socket.id, userName);
    }

    socket.join(roomId);
    socket.data.roomId   = roomId;
    socket.data.userName = userName;

    socket.emit('room-joined', {
      roomId,
      isHost:      room.hostId === socket.id,
      hostId:      room.hostId,
      users:       safeUsers(room),
      videoId:     room.videoId,
      currentTime: room.currentTime,
      isPlaying:   room.isPlaying,
      isScreenSharing: room.isScreenSharing,
      sharerId:    room.sharerId,
    });

    socket.to(roomId).emit('user-joined', {
      user:  { id: socket.id, name: userName, isReady: false, isMuted: true, inVoice: false },
      users: safeUsers(room),
    });

    console.log(`[room] ${userName} ${isCreating ? 'created' : 'joined'} ${roomId}`);
  });

  // ── YouTube playback ───────────────────────────────────────────────────────
  socket.on('set-video', ({ roomId, videoId }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    updateVideo(roomId, videoId);
    io.to(roomId).emit('video-changed', { videoId });
  });

  socket.on('play', ({ roomId, currentTime }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    updatePlayback(roomId, { currentTime, isPlaying: true });
    socket.to(roomId).emit('play', { currentTime });
  });

  socket.on('pause', ({ roomId, currentTime }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    updatePlayback(roomId, { currentTime, isPlaying: false });
    socket.to(roomId).emit('pause', { currentTime });
  });

  socket.on('seek', ({ roomId, currentTime }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    updatePlayback(roomId, { currentTime });
    socket.to(roomId).emit('seek', { currentTime });
  });

  socket.on('sync', ({ roomId, currentTime, isPlaying }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room || room.hostId !== socket.id) return;
    updatePlayback(roomId, { currentTime, isPlaying });
    socket.to(roomId).emit('sync', { currentTime, isPlaying });
  });

  // ── Screen Share Signaling ─────────────────────────────────────────────────
  // Anyone can share. Server just relays — all race conditions fixed on client.

  socket.on('screen-share-start', ({ roomId }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room) return;
    const sharer = room.users.find((u) => u.id === socket.id);
    room.isScreenSharing = true;
    room.sharerId = socket.id;
    socket.to(roomId).emit('screen-share-start', {
      sharerId:   socket.id,
      sharerName: sharer?.name || 'Someone',
    });
    console.log(`[screen] ${sharer?.name} sharing in ${roomId}`);
  });

  socket.on('screen-share-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('screen-share-offer', { offer, sharerId: socket.id });
  });

  socket.on('screen-share-answer', ({ sharerId, answer }) => {
    io.to(sharerId).emit('screen-share-answer', { answer, viewerId: socket.id });
  });

  socket.on('screen-share-ready', ({ sharerId }) => {
    io.to(sharerId).emit('screen-share-ready', { viewerId: socket.id });
  });

  socket.on('screen-share-stop', ({ roomId }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room || room.sharerId !== socket.id) return;
    room.isScreenSharing = false;
    room.sharerId = null;
    socket.to(roomId).emit('screen-share-stop');
  });

  // ── Voice Chat Signaling (WebRTC mesh for audio) ───────────────────────────
  /**
   * Flow:
   *  1. User emits voice-join → server sends back list of existing voice users
   *  2. Joining user creates offers to each existing voice user
   *  3. Existing users respond with answers
   *  4. ICE candidates relayed bidirectionally
   */
  socket.on('voice-join', ({ roomId }) => {
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room) return;

    // List of users already in voice (not including the joiner)
    const existingVoiceUsers = [...room.voiceUsers].filter((id) => id !== socket.id);

    // Register joiner
    const updatedRoom = joinVoice(roomId, socket.id);
    if (!updatedRoom) return;

    // Tell the joiner who is already in voice so they can create offers
    socket.emit('voice-users', { users: existingVoiceUsers });

    // Tell existing voice users that a new user joined (so they wait for an offer)
    socket.to(roomId).emit('voice-user-joined', { userId: socket.id });

    // Broadcast updated user list to room
    io.to(roomId).emit('users-updated', { users: safeUsers(updatedRoom) });
    console.log(`[voice] ${socket.data.userName} joined voice in ${roomId}`);
  });

  socket.on('voice-leave', ({ roomId }) => {
    roomId = roomId?.toUpperCase();
    const room = leaveVoice(roomId, socket.id);
    if (!room) return;
    socket.to(roomId).emit('voice-user-left', { userId: socket.id });
    io.to(roomId).emit('users-updated', { users: safeUsers(room) });
  });

  socket.on('voice-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('voice-offer', { offer, fromId: socket.id });
  });

  socket.on('voice-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('voice-answer', { answer, fromId: socket.id });
  });

  socket.on('voice-mute', ({ roomId, isMuted }) => {
    roomId = roomId?.toUpperCase();
    const room = setMuted(roomId, socket.id, isMuted);
    if (!room) return;
    io.to(roomId).emit('users-updated', { users: safeUsers(room) });
  });

  // Shared ICE candidate relay for both screen share and voice
  socket.on('ice-candidate', ({ targetId, candidate, kind }) => {
    io.to(targetId).emit('ice-candidate', { candidate, fromId: socket.id, kind });
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    if (!message?.trim()) return;
    roomId = roomId?.toUpperCase();
    const room = getRoom(roomId);
    if (!room) return;
    const sender = room.users.find((u) => u.id === socket.id);
    if (!sender) return;
    io.to(roomId).emit('chat-message', {
      id: uuidv4(), userId: socket.id,
      userName: sender.name,
      message:  message.trim().slice(0, 500),
      timestamp: Date.now(),
    });
  });

  // ── Ready ──────────────────────────────────────────────────────────────────
  socket.on('toggle-ready', ({ roomId, isReady }) => {
    roomId = roomId?.toUpperCase();
    const room = setReady(roomId, socket.id, isReady);
    if (!room) return;
    io.to(roomId).emit('users-updated', { users: safeUsers(room) });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { roomId, userName } = socket.data;
    if (!roomId) return;
    const room = leaveRoom(roomId, socket.id);
    if (room) {
      io.to(roomId).emit('user-left', {
        userId: socket.id, userName,
        users:  safeUsers(room),
        newHostId: room.hostId,
      });
      // Tell voice peers this user left
      io.to(roomId).emit('voice-user-left', { userId: socket.id });
    }
    console.log(`[-] ${socket.id} (${userName})`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () =>
  console.log(`\n🎬 Watch Party v2 on http://localhost:${PORT} [${isProd ? 'prod' : 'dev'}]\n`)
);
