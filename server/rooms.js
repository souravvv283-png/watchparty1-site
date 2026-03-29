/**
 * rooms.js — in-memory store
 *
 * Room shape:
 * {
 *   roomId, hostId,
 *   users:      [{ id, name, isReady, isMuted, inVoice }]
 *   videoId, currentTime, isPlaying, lastUpdate,
 *   isScreenSharing, sharerId,
 *   voiceUsers: Set<socketId>
 * }
 */

const rooms = new Map();

function createRoom(roomId, hostSocketId, hostName) {
  const room = {
    roomId,
    hostId: hostSocketId,
    users: [{ id: hostSocketId, name: hostName, isReady: false, isMuted: true, inVoice: false }],
    videoId: null,
    currentTime: 0,
    isPlaying: false,
    lastUpdate: Date.now(),
    isScreenSharing: false,
    sharerId: null,
    voiceUsers: new Set(),
  };
  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function joinRoom(roomId, userId, userName) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.users = room.users.filter((u) => u.id !== userId);
  room.users.push({ id: userId, name: userName, isReady: false, isMuted: true, inVoice: false });
  return room;
}

function leaveRoom(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.users = room.users.filter((u) => u.id !== userId);
  room.voiceUsers.delete(userId);
  if (room.users.length === 0) { rooms.delete(roomId); return null; }
  if (room.hostId === userId) room.hostId = room.users[0].id;
  if (room.sharerId === userId) { room.isScreenSharing = false; room.sharerId = null; }
  return room;
}

function updateVideo(roomId, videoId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.videoId = videoId; room.currentTime = 0; room.isPlaying = false;
  room.lastUpdate = Date.now();
  return room;
}

function updatePlayback(roomId, { currentTime, isPlaying }) {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (currentTime !== undefined) room.currentTime = currentTime;
  if (isPlaying  !== undefined) room.isPlaying  = isPlaying;
  room.lastUpdate = Date.now();
  return room;
}

function setReady(roomId, userId, isReady) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const u = room.users.find((u) => u.id === userId);
  if (u) u.isReady = isReady;
  return room;
}

function joinVoice(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.voiceUsers.add(userId);
  const u = room.users.find((u) => u.id === userId);
  if (u) u.inVoice = true;
  return room;
}

function leaveVoice(roomId, userId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.voiceUsers.delete(userId);
  const u = room.users.find((u) => u.id === userId);
  if (u) { u.inVoice = false; u.isMuted = true; }
  return room;
}

function setMuted(roomId, userId, isMuted) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const u = room.users.find((u) => u.id === userId);
  if (u) u.isMuted = isMuted;
  return room;
}

module.exports = {
  createRoom, getRoom, joinRoom, leaveRoom,
  updateVideo, updatePlayback, setReady,
  joinVoice, leaveVoice, setMuted,
};
