import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, "public")));

const WORLD_W = 3000, WORLD_H = 2000;
const TICK_RATE = 30, BROADCAST_RATE = 20;

const world = { players: {}, bullets: [], obstacles: [] };
const respawnTimers = new Map(); 

function spawnObstacles(count = 80) {
  world.obstacles = [];
  for (let i = 0; i < count; i++) {
    const r = Math.random();
    const o = { id: uuidv4(), x: Math.random() * WORLD_W, y: Math.random() * WORLD_H };
    if (r < 0.5) {
      o.type = "rect";
      o.w = 60 + Math.random() * 60;
      o.h = 60 + Math.random() * 60;
    } else {
      o.type = "hex";
      o.size = 60 + Math.random() * 50;
    }

    o.maxHp = 120 + Math.random() * 150;
    o.hp = o.maxHp;
    world.obstacles.push(o);
  }
}
spawnObstacles();
function respawnObstacle(id) {
  const r = Math.random();
  const newObs = {
    id: id, 
    x: Math.random() * WORLD_W,
    y: Math.random() * WORLD_H
  };
  if (r < 0.5) {
    newObs.type = "rect";
    newObs.w = 60 + Math.random() * 60;
    newObs.h = 60 + Math.random() * 60;
  } else {
    newObs.type = "hex";
    newObs.size = 60 + Math.random() * 50;
  }
  newObs.maxHp = 120 + Math.random() * 150;
  newObs.hp = newObs.maxHp;

  const index = world.obstacles.findIndex(o => o.id === id);
  if (index !== -1) {
    world.obstacles[index] = newObs;
  }
  respawnTimers.delete(id);
}


function createPlayer(id) {
  return {
    id,
    x: Math.random() * WORLD_W,
    y: Math.random() * WORLD_H,
    vx: 0, vy: 0,
    angle: 0,
    size: 20,
    hp: 100, maxHp: 100,
    score: 0, xp: 0, level: 1,
    xpToLevel: 10,
    damage: 20,
    fireCooldown: 0.3,
    speed: 220,
    regen: 1,
    bulletLife: 1.8,
    bulletSpeed: 850,
    lastShot: 0,
    inputs: { up: false, down: false, left: false, right: false, aimX: 0, aimY: 0, firing: false, autoFire: false },
  };
}

function resetPlayer(p) {
  p.hp = p.maxHp = 100;
  p.xp = 0;
  p.level = 1;
  p.score = 0;
  p.damage = 20;
  p.fireCooldown = 0.3;
  p.speed = 220;
  p.regen = 1;
  p.bulletLife = 1.8;
  p.bulletSpeed = 850;
  p.x = Math.random() * WORLD_W;
  p.y = Math.random() * WORLD_H;
}

function createBullet(owner, x, y, angle, speed, life, dmg) {
  return {
    id: uuidv4(),
    ownerId: owner.id,
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    size: 5,
    life,
    damage: dmg
  };
}

function pointInObstacle(px, py, o) {
  if (o.type === "rect") return px > o.x && px < o.x + o.w && py > o.y && py < o.y + o.h;
  if (o.type === "tri") {
    const s = o.size;
    const x1 = o.x, y1 = o.y - s / 2, x2 = o.x - s / 2, y2 = o.y + s / 2, x3 = o.x + s / 2, y3 = o.y + s / 2;
    const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    const a = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / d;
    const b = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / d;
    const c = 1 - a - b;
    return a >= 0 && b >= 0 && c >= 0;
  }
  if (o.type === "hex") {
    const s = o.size / 2, dx = Math.abs(px - o.x), dy = Math.abs(py - o.y);
    return dx <= s && dy <= s * 0.866;
  }
  return false;
}

function playersCollide(p1, p2) {
  const dx = p1.x - p2.x, dy = p1.y - p2.y;
  return Math.hypot(dx, dy) < p1.size + p2.size;
}

wss.on("connection", (ws) => {
  const id = uuidv4();
  const p = createPlayer(id);
  world.players[id] = p;
  ws.id = id;

  ws.send(JSON.stringify({ type: "welcome", id, worldSize: { w: WORLD_W, h: WORLD_H } }));

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      const pl = world.players[id];
      if (!pl) return;
      if (msg.type === "input") pl.inputs = { ...pl.inputs, ...msg.data };
      if (msg.type === "upgrade") {
        const c = msg.choice;
        if (c === "hpMax") pl.maxHp += 20, pl.hp = pl.maxHp;
        if (c === "regen") pl.regen += 0.5;
        if (c === "speed") pl.speed += 20;
        if (c === "fireRate") pl.fireCooldown *= 0.9;
        if (c === "damage") pl.damage += 5;
        if (c === "bulletSpeed") pl.bulletSpeed += 100;
        if (c === "bulletLife") pl.bulletLife += 0.2;
      }
    } catch { }
  });

  ws.on("close", () => delete world.players[id]);
});

let last = Date.now() / 1000;
function update() {
  const now = Date.now() / 1000;
  const dt = Math.min(0.1, now - last);
  last = now;

  for (const id in world.players) {
    const p = world.players[id];
    let dx = 0, dy = 0;
    if (p.inputs.up) dy -= 1;
    if (p.inputs.down) dy += 1;
    if (p.inputs.left) dx -= 1;
    if (p.inputs.right) dx += 1;
    const len = Math.hypot(dx, dy) || 1;
    p.x += (dx / len) * p.speed * dt;
    p.y += (dy / len) * p.speed * dt;
    p.x = Math.max(0, Math.min(WORLD_W, p.x));
    p.y = Math.max(0, Math.min(WORLD_H, p.y));

    if (p.inputs.aimX && p.inputs.aimY)
      p.angle = Math.atan2(p.inputs.aimY - p.y, p.inputs.aimX - p.x);

    for (const o of world.obstacles) {
      if (o.hp <= 0) continue;

      if (o.type === "rect") {
        const closestX = Math.max(o.x, Math.min(p.x, o.x + o.w));
        const closestY = Math.max(o.y, Math.min(p.y, o.y + o.h));
        const distX = p.x - closestX;
        const distY = p.y - closestY;
        const dist = Math.hypot(distX, distY);

        if (dist < p.size) {
          p.hp -= 25 * dt;
          const overlap = p.size - dist;
          const nx = distX / (dist || 1);
          const ny = distY / (dist || 1);
          p.x += nx * overlap;
          p.y += ny * overlap;
        }
      } else if (pointInObstacle(p.x, p.y, o)) {
        p.hp -= 25 * dt;
        const dx = p.x - o.x;
        const dy = p.y - o.y;
        const len = Math.hypot(dx, dy) || 1;
        p.x += (dx / len) * 5;
        p.y += (dy / len) * 5;
      }
    }

    for (const id2 in world.players) {
      if (id === id2) continue;
      const p2 = world.players[id2];
      if (playersCollide(p, p2)) {
        const angle = Math.atan2(p.y - p2.y, p.x - p2.x);
        const push = 4;
        p.x += Math.cos(angle) * push;
        p.y += Math.sin(angle) * push;
        p.hp -= 10 * dt;
      }
    }

    p.hp = Math.min(p.hp + p.regen * dt, p.maxHp);

    const wantFire = p.inputs.firing || p.inputs.autoFire;
    if (wantFire && now - p.lastShot > p.fireCooldown) {
      p.lastShot = now;
      const b = createBullet(p, p.x + Math.cos(p.angle) * (p.size + 10), p.y + Math.sin(p.angle) * (p.size + 10),
        p.angle, p.bulletSpeed, p.bulletLife, p.damage);
      world.bullets.push(b);
    }

    if (p.hp <= 0) resetPlayer(p);
  }

  for (let i = world.bullets.length - 1; i >= 0; i--) {
    const b = world.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) { world.bullets.splice(i, 1); continue; }

    let hit = false;

    for (const o of world.obstacles) {
      if (pointInObstacle(b.x, b.y, o)) {
        if (o.hp <= 0) continue;
        o.hp -= b.damage;
        hit = true;
        if (o.hp <= 0) {
          o.hp = 0;
          const owner = world.players[b.ownerId];
          if (owner) {
            owner.score += 10;
            owner.xp += 5;
            if (owner.xp >= owner.xpToLevel) {
              owner.level++;
              owner.xp -= owner.xpToLevel;
              owner.xpToLevel = Math.round(owner.xpToLevel * 1.3);
              wss.clients.forEach(ws => {
                if (ws.id === owner.id && ws.readyState === 1)
                  ws.send(JSON.stringify({ type: "levelup", level: owner.level }));
              });
            }
          }
          
          respawnTimers.set(o.id, Date.now() / 1000);

        }
        break;
      }
    }

    if (!hit) {
      for (const id in world.players) {
        const p = world.players[id];
        if (p.id === b.ownerId) continue;
        const dist = Math.hypot(p.x - b.x, p.y - b.y);
        if (dist < p.size + b.size) {
          p.hp -= b.damage;
          const owner = world.players[b.ownerId];
          if (p.hp <= 0 && owner) {
            owner.score += 20;
            owner.xp += 10;
          }
          hit = true;
          break;
        }
      }
    }

    if (hit) world.bullets.splice(i, 1);
  }
  for (const [id, time] of respawnTimers.entries()) {
    const nowSec = Date.now() / 1000;
    if (nowSec >= time) {
      respawnObstacle(id);
    }
  }
}

setInterval(update, 1000 / TICK_RATE);

setInterval(() => {
  const sorted = Object.values(world.players).sort((a, b) => b.score - a.score).slice(0, 5);
  const payload = JSON.stringify({
    type: "state",
    players: Object.values(world.players),
    bullets: world.bullets,
    obstacles: world.obstacles,
    leaderboard: sorted.map(p => ({ id: p.id, score: p.score, level: p.level }))
  }); 
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}, 1000 / BROADCAST_RATE);

server.listen(3000, () => console.log("Server running at http://localhost:3000"));
