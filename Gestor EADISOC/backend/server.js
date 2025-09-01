
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import morgan from "morgan";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import dotenv from "dotenv";
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: "*" } });
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
const DATA_DIR = path.join(__dirname, "data");
const PATIENTS_FILE = path.join(DATA_DIR, "patients.json");
const LOCKS_FILE = path.join(DATA_DIR, "locks.json");
const LOCK_TTL_SECONDS = parseInt(process.env.LOCK_TTL_SECONDS || "180");
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || "60");
const PORT = parseInt(process.env.PORT || "4000");
async function readJson(file) { const content = await fs.readFile(file, "utf-8"); return JSON.parse(content); }
async function writeJsonAtomic(file, data) { const tmp = file + ".tmp"; await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8"); await fs.rename(tmp, file); }
function nowSec() { return Math.floor(Date.now() / 1000); }
async function purgeExpiredLocks() {
  const locks = await readJson(LOCKS_FILE);
  const t = nowSec();
  let changed = false;
  for (const [caso, lock] of Object.entries(locks)) {
    if (!lock || (lock.expiresAt && lock.expiresAt <= t)) {
      delete locks[caso];
      changed = true;
    }
  }
  if (changed) {
    await writeJsonAtomic(LOCKS_FILE, locks);
    io.emit("lock:updated", locks);
  }
  return locks;
}
setInterval(() => { purgeExpiredLocks().catch(console.error); }, 5000);
app.get("/api/patients", async (_req, res) => {
  const patients = await readJson(PATIENTS_FILE);
  const locks = await purgeExpiredLocks();
  const withLocks = patients.map(p => ({ ...p, lockedBy: locks[p.caso]?.user || null, lockExpiresAt: locks[p.caso]?.expiresAt || null }));
  res.json(withLocks);
});
app.post("/api/patients", async (req, res) => {
  const patients = await readJson(PATIENTS_FILE);
  const body = req.body || {};
  if (!body.nombre) return res.status(400).json({ error: "nombre requerido" });
  const nextCaso = (Math.max(0, ...patients.map(p => parseInt(p.caso))) + 1).toString();
  const patient = { caso: nextCaso, nombre: body.nombre, fechaNac: body.fechaNac || "", edad: body.edad || 0, diagnostico: body.diagnostico || "", estado: body.estado || "Pendiente", centroEscolar: body.centroEscolar || "", centroSalud: body.centroSalud || "", derivacion: body.derivacion || "", protocoloEscolar: body.protocoloEscolar || "No", pruebas: body.pruebas || [], notas: body.notas || [] };
  patients.push(patient);
  await writeJsonAtomic(PATIENTS_FILE, patients);
  io.emit("patients:updated", patients);
  res.status(201).json(patient);
});
app.put("/api/patients/:caso", async (req, res) => {
  const { caso } = req.params;
  const patients = await readJson(PATIENTS_FILE);
  const idx = patients.findIndex(p => p.caso === caso);
  if (idx === -1) return res.status(404).json({ error: "No encontrado" });
  const locks = await purgeExpiredLocks();
  const lock = locks[caso];
  const { userId } = req.body || {};
  if (lock && lock.user && lock.user.id !== userId) {
    return res.status(423).json({ error: `Bloqueado por ${lock.user.username}` });
  }
  const merged = { ...patients[idx], ...req.body };
  delete merged.userId;
  patients[idx] = merged;
  await writeJsonAtomic(PATIENTS_FILE, patients);
  io.emit("patients:updated", patients);
  res.json(merged);
});
app.delete("/api/patients/:caso", async (req, res) => {
  const { caso } = req.params;
  const patients = await readJson(PATIENTS_FILE);
  const idx = patients.findIndex(p => p.caso === caso);
  if (idx === -1) return res.status(404).json({ error: "No encontrado" });
  patients.splice(idx, 1);
  await writeJsonAtomic(PATIENTS_FILE, patients);
  const locks = await purgeExpiredLocks();
  if (locks[caso]) { delete locks[caso]; await writeJsonAtomic(LOCKS_FILE, locks); }
  io.emit("patients:updated", patients);
  io.emit("lock:updated", await readJson(LOCKS_FILE));
  res.json({ ok: true });
});
app.get("/api/locks", async (_req, res) => { const locks = await purgeExpiredLocks(); res.json(locks); });
app.post("/api/lock/:caso", async (req, res) => {
  const { caso } = req.params;
  const { userId, username } = req.body || {};
  if (!userId || !username) return res.status(400).json({ error: "userId y username requeridos" });
  const locks = await purgeExpiredLocks();
  const existing = locks[caso];
  const t = nowSec();
  if (existing && existing.user && existing.user.id !== userId) {
    return res.status(423).json({ error: `Paciente bloqueado por ${existing.user.username}`, lock: existing });
  }
  const lock = { id: nanoid(8), user: { id: userId, username }, createdAt: t, expiresAt: t + LOCK_TTL_SECONDS };
  locks[caso] = lock;
  await writeJsonAtomic(LOCKS_FILE, locks);
  io.emit("lock:updated", locks);
  res.json(lock);
});
app.post("/api/lock/:caso/heartbeat", async (req, res) => {
  const { caso } = req.params;
  const { userId } = req.body || {};
  const locks = await purgeExpiredLocks();
  const existing = locks[caso];
  const t = nowSec();
  if (!existing || !existing.user || existing.user.id !== userId) {
    return res.status(409).json({ error: "Lock no encontrado o no te pertenece" });
  }
  existing.expiresAt = t + LOCK_TTL_SECONDS;
  locks[caso] = existing;
  await writeJsonAtomic(LOCKS_FILE, locks);
  io.emit("lock:updated", locks);
  res.json(existing);
});
app.delete("/api/lock/:caso", async (req, res) => {
  const { caso } = req.params;
  const { userId } = req.body || {};
  const locks = await purgeExpiredLocks();
  const existing = locks[caso];
  if (existing && existing.user && existing.user.id !== userId) {
    return res.status(423).json({ error: "No puedes liberar un bloqueo de otro usuario" });
  }
  delete locks[caso];
  await writeJsonAtomic(LOCKS_FILE, locks);
  io.emit("lock:updated", locks);
  res.json({ ok: true });
});
app.get("/", (_req, res) => { res.send("EADISOC Backend + Socket.IO OK"); });
io.on("connection", (socket) => {
  console.log("socket connected", socket.id);
  socket.on("patients:request", async () => {
    const patients = await readJson(PATIENTS_FILE);
    const locks = await purgeExpiredLocks();
    const withLocks = patients.map(p => ({ ...p, lockedBy: locks[p.caso]?.user || null, lockExpiresAt: locks[p.caso]?.expiresAt || null }));
    socket.emit("patients:response", withLocks);
  });
  socket.on("lock:request", async (payload) => {
    try {
      const { caso, user } = payload || {};
      if (!caso || !user || !user.id) return socket.emit("lock:error", { error: "payload inválido" });
      const locks = await purgeExpiredLocks();
      const existing = locks[caso];
      const t = nowSec();
      if (existing && existing.user && existing.user.id !== user.id) {
        return socket.emit("lock:denied", { caso, lock: existing });
      }
      const lock = { id: nanoid(8), user: { id: user.id, username: user.username }, createdAt: t, expiresAt: t + LOCK_TTL_SECONDS };
      locks[caso] = lock;
      await writeJsonAtomic(LOCKS_FILE, locks);
      io.emit("lock:updated", locks);
      socket.emit("lock:granted", { caso, lock });
    } catch (err) { socket.emit("lock:error", { error: err.message }); }
  });
  socket.on("lock:release", async (payload) => {
    try {
      const { caso, user } = payload || {};
      const locks = await purgeExpiredLocks();
      const existing = locks[caso];
      if (existing && existing.user && existing.user.id !== user.id) {
        return socket.emit("lock:error", { error: "No puedes liberar un bloqueo de otro usuario" });
      }
      delete locks[caso];
      await writeJsonAtomic(LOCKS_FILE, locks);
      io.emit("lock:updated", locks);
      socket.emit("lock:released", { caso });
    } catch (err) { socket.emit("lock:error", { error: err.message }); }
  });
  socket.on("heartbeat", async (payload) => {
    try {
      const { caso, user } = payload || {};
      const locks = await purgeExpiredLocks();
      const existing = locks[caso];
      const t = nowSec();
      if (!existing || !existing.user || existing.user.id !== user.id) {
        return socket.emit("heartbeat:error", { error: "Lock no encontrado o no te pertenece" });
      }
      existing.expiresAt = t + LOCK_TTL_SECONDS;
      locks[caso] = existing;
      await writeJsonAtomic(LOCKS_FILE, locks);
      io.emit("lock:updated", locks);
      socket.emit("heartbeat:ok", { caso, lock: existing });
    } catch (err) { socket.emit("heartbeat:error", { error: err.message }); }
  });
  socket.on("disconnect", () => { console.log("socket disconnected", socket.id); });
});
server.listen(PORT, () => { console.log(`Server listening on http://localhost:${PORT}`); console.log(`LOCK_TTL_SECONDS=${LOCK_TTL_SECONDS}, HEARTBEAT_INTERVAL=${HEARTBEAT_INTERVAL}`); });
