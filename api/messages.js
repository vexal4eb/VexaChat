const MAX_NAME = 24;
const MAX_TEXT = 200;
const KEEP = 50;
const WINDOW_SECONDS = 5;
const WINDOW_LIMIT = 6;
const MAX_ROOMS = 5;
const MAX_MEMBERS = 20;
const ROLE_NAMES = ["mod", "vip", "member"];
const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const DENIED = "No permission.";

const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(commands) {
	const response = await fetch(base + "/pipeline", {
		method: "POST",
		headers: { Authorization: "Bearer " + token },
		body: JSON.stringify(commands),
	});
	const results = await response.json();
	return results.map((entry) => entry.result);
}

function parse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function cleanId(value) {
	return String(value || "").replace(/[^\w-]/g, "").slice(0, 40);
}

function cleanName(value) {
	return String(value || "").replace(/[^\w]/g, "").slice(0, MAX_NAME);
}

function newCode() {
	let code = "";
	for (let i = 0; i < 5; i++) {
		code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
	}
	return code;
}

function pairs(flat) {
	const out = [];
	const list = flat || [];
	for (let i = 0; i + 1 < list.length; i += 2) {
		out.push([list[i], list[i + 1]]);
	}
	return out;
}

function roomOf(channel) {
	return typeof channel === "string" && channel.startsWith("room:") ? cleanId(channel.slice(5)) : null;
}

function channelKey(channel, gid) {
	if (channel === "game") {
		return "chat:msgs:game:" + (cleanId(gid) || "none");
	}
	const room = roomOf(channel);
	if (room) {
		return "chat:msgs:room:" + room;
	}
	return "chat:msgs:global";
}

function collect(raw, after) {
	const floor = Number.isFinite(after) ? after : -1;
	let messages = (raw || []).map(parse).filter((m) => m && m.id > floor);
	if (floor < 0) {
		messages = messages.slice(0, 20);
	}
	messages.reverse();
	const last = messages.reduce((max, m) => Math.max(max, m.id), Math.max(floor, 0));
	return { messages, last };
}

function parseCursors(raw) {
	const value = parse(raw);
	return value && typeof value === "object" ? value : {};
}

async function push(key, entry) {
	const [id] = await redis([["INCR", "chat:tick"]]);
	await redis([
		["LPUSH", key, JSON.stringify({ id, ...entry })],
		["LTRIM", key, 0, KEEP - 1],
	]);
}

async function findUid(name) {
	const lowered = cleanName(name).toLowerCase();
	if (!lowered) {
		return null;
	}
	const [uid] = await redis([["HGET", "chat:names", lowered]]);
	return uid || null;
}

async function namesOf(uids) {
	if (!uids || !uids.length) {
		return [];
	}
	const [values] = await redis([["HMGET", "chat:unames", ...uids]]);
	return (values || []).filter(Boolean);
}

async function roomContext(ctx, roomId) {
	if (!roomId) {
		return null;
	}
	const [member, meta] = await redis([
		["SISMEMBER", "chat:room:" + roomId + ":members", ctx.uid],
		["HGETALL", "chat:room:" + roomId],
	]);
	if (!member) {
		return null;
	}
	const info = Object.fromEntries(pairs(meta));
	return { id: roomId, name: info.name || roomId, owner: info.owner, members: "chat:room:" + roomId + ":members" };
}

async function authenticate(req, name) {
	const uid = cleanId(req.headers["x-uid"]);
	const secret = String(req.headers["x-token"] || "").slice(0, 100);
	if (!uid || secret.length < 16 || !name) {
		return { error: "identity" };
	}

	const lowered = name.toLowerCase();
	const [, bound, owner, oldName] = await redis([
		["HSETNX", "chat:tokens", uid, secret],
		["HGET", "chat:tokens", uid],
		["HGET", "chat:names", lowered],
		["HGET", "chat:unames", uid],
	]);

	if (bound !== secret) {
		return { error: "identity" };
	}
	if (owner && owner !== uid) {
		return { error: "name" };
	}

	if (owner !== uid || oldName !== name) {
		const commands = [
			["HSET", "chat:names", lowered, uid],
			["HSET", "chat:unames", uid, name],
		];
		if (oldName && oldName.toLowerCase() !== lowered) {
			commands.push(["HDEL", "chat:names", oldName.toLowerCase()]);
		}
		await redis(commands);
	}

	return { uid };
}

async function runCommand(ctx, body, key) {
	const command = String(body.command || "").toLowerCase();
	const args = String(body.arg || "").trim();
	const parts = args.split(/\s+/).filter(Boolean);
	const roomId = roomOf(body.channel);

	if (command === "room") {
		if ((parts[0] || "").toLowerCase() !== "create") {
			return "Usage: /room create Name";
		}
		const title = parts.slice(1).join(" ").replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 24);
		if (!title) {
			return "Name missing.";
		}
		const [count] = await redis([["SCARD", "chat:uroom:" + ctx.uid]]);
		if (count >= MAX_ROOMS) {
			return "Maximum of " + MAX_ROOMS + " rooms.";
		}
		const id = newCode();
		await redis([
			["HSET", "chat:room:" + id, "name", title, "owner", ctx.uid],
			["SADD", "chat:room:" + id + ":members", ctx.uid],
			["SADD", "chat:uroom:" + ctx.uid, id],
		]);
		return "Room '" + title + "' created. Code: " + id;
	}

	if (command === "invite") {
		const room = await roomContext(ctx, roomId);
		if (!room) {
			return "Only possible in a room tab.";
		}
		const target = await findUid(parts[0]);
		if (!target) {
			return "Unknown player.";
		}
		const [already, size] = await redis([
			["SISMEMBER", room.members, target],
			["SCARD", room.members],
		]);
		if (already) {
			return "Already in the room.";
		}
		if (size >= MAX_MEMBERS) {
			return "Room is full.";
		}
		await redis([["HSET", "chat:inv:" + target, room.id, room.name + "|" + ctx.name]]);
		return "Invite sent to " + cleanName(parts[0]) + ".";
	}

	if (command === "join") {
		const id = cleanId(parts[0]);
		if (!id) {
			return "Usage: /join code";
		}
		const [invite, exists, count] = await redis([
			["HGET", "chat:inv:" + ctx.uid, id],
			["EXISTS", "chat:room:" + id],
			["SCARD", "chat:uroom:" + ctx.uid],
		]);
		if (!invite || !exists) {
			return "No invite for this code.";
		}
		if (count >= MAX_ROOMS) {
			return "Maximum of " + MAX_ROOMS + " rooms.";
		}
		await redis([
			["SADD", "chat:room:" + id + ":members", ctx.uid],
			["SADD", "chat:uroom:" + ctx.uid, id],
			["HDEL", "chat:inv:" + ctx.uid, id],
		]);
		await push("chat:msgs:room:" + id, { text: ctx.name + " joined the room.", kind: "system" });
		return "Joined room.";
	}

	if (command === "decline") {
		const id = cleanId(parts[0]);
		await redis([["HDEL", "chat:inv:" + ctx.uid, id]]);
		return "Invite declined.";
	}

	if (command === "leave") {
		const room = await roomContext(ctx, roomId);
		if (!room) {
			return "Only possible in a room tab.";
		}
		await redis([
			["SREM", room.members, ctx.uid],
			["SREM", "chat:uroom:" + ctx.uid, room.id],
		]);
		const [left] = await redis([["SMEMBERS", room.members]]);
		if (!left || !left.length) {
			await redis([["DEL", "chat:room:" + room.id, room.members, "chat:msgs:room:" + room.id]]);
			return "Room deleted.";
		}
		if (room.owner === ctx.uid) {
			await redis([["HSET", "chat:room:" + room.id, "owner", left[0]]]);
		}
		await push("chat:msgs:room:" + room.id, { text: ctx.name + " left the room.", kind: "system" });
		return "Left room.";
	}

	if (command === "kick") {
		const room = await roomContext(ctx, roomId);
		if (!room) {
			return "Only possible in a room tab.";
		}
		if (room.owner !== ctx.uid && !ctx.staff) {
			return DENIED;
		}
		const target = await findUid(parts[0]);
		if (!target || target === ctx.uid) {
			return "Invalid target.";
		}
		const [removed] = await redis([["SREM", room.members, target]]);
		if (!removed) {
			return "Not in the room.";
		}
		await redis([["SREM", "chat:uroom:" + target, room.id]]);
		await push("chat:msgs:room:" + room.id, { text: cleanName(parts[0]) + " was removed.", kind: "system" });
		return cleanName(parts[0]) + " removed.";
	}

	if (command === "members") {
		const room = await roomContext(ctx, roomId);
		if (!room) {
			return "Only possible in a room tab.";
		}
		const [ids] = await redis([["SMEMBERS", room.members]]);
		const names = await namesOf(ids);
		return "Members: " + names.join(", ");
	}

	if (command === "timeout" || command === "untimeout") {
		if (!ctx.staff) {
			return DENIED;
		}
		const target = await findUid(parts[0]);
		if (!target) {
			return "Unknown player.";
		}
		if (command === "untimeout") {
			await redis([["DEL", "chat:timeout:" + target]]);
			return cleanName(parts[0]) + " can talk again.";
		}
		const [targetRole] = await redis([["HGET", "chat:roles", target]]);
		if (target === ctx.uid || targetRole === "admin" || (targetRole === "mod" && !ctx.admin)) {
			return "Not allowed.";
		}
		const minutes = Math.min(Math.max(parseInt(parts[1], 10) || 10, 1), 1440);
		await redis([["SET", "chat:timeout:" + target, "1", "EX", minutes * 60]]);
		return cleanName(parts[0]) + " timed out for " + minutes + " min.";
	}

	if (command === "clear") {
		if (!ctx.staff) {
			return DENIED;
		}
		await redis([["DEL", key]]);
		await push(key, { name: ctx.name, text: "", kind: "clear" });
		return "Cleared.";
	}

	if (command === "slow") {
		if (!ctx.staff) {
			return DENIED;
		}
		const seconds = Math.min(Math.max(parseInt(parts[0], 10) || 0, 0), 300);
		if (seconds === 0) {
			await redis([["DEL", "chat:slow:" + key]]);
		} else {
			await redis([["SET", "chat:slow:" + key, String(seconds)]]);
		}
		await push(key, { text: seconds ? "Slowmode: " + seconds + " s" : "Slowmode off.", kind: "system" });
		return seconds ? "Slowmode " + seconds + " s." : "Slowmode off.";
	}

	if (command === "bans") {
		if (!ctx.staff) {
			return DENIED;
		}
		const [uids] = await redis([["SMEMBERS", "chat:ban:uids"]]);
		const names = await namesOf(uids);
		return names.length ? "Banned: " + names.join(", ") : "Nobody is banned.";
	}

	if (command === "ban" || command === "unban") {
		if (!ctx.admin) {
			return DENIED;
		}
		const target = await findUid(parts[0]);
		if (!target) {
			return "Unknown player.";
		}
		if (target === ctx.uid) {
			return "Not allowed.";
		}
		const [ip] = await redis([["HGET", "chat:ips", target]]);
		if (command === "ban") {
			const commands = [["SADD", "chat:ban:uids", target]];
			if (ip) {
				commands.push(["SADD", "chat:ban:ips", ip]);
			}
			await redis(commands);
			return cleanName(parts[0]) + " banned.";
		}
		const commands = [["SREM", "chat:ban:uids", target]];
		if (ip) {
			commands.push(["SREM", "chat:ban:ips", ip]);
		}
		await redis(commands);
		return cleanName(parts[0]) + " unbanned.";
	}

	if (command === "announce") {
		if (!ctx.admin) {
			return DENIED;
		}
		if (!args) {
			return "Text missing.";
		}
		await push("chat:msgs:global", { name: ctx.name, text: args.slice(0, MAX_TEXT), kind: "announce" });
		return "Announcement sent.";
	}

	if (command === "role") {
		if (!ctx.admin) {
			return DENIED;
		}
		const role = (parts[1] || "").toLowerCase();
		if (!ROLE_NAMES.includes(role)) {
			return "Usage: /role name mod|vip|member";
		}
		const target = await findUid(parts[0]);
		if (!target) {
			return "Unknown player.";
		}
		if (role === "member") {
			await redis([["HDEL", "chat:roles", target]]);
		} else {
			await redis([["HSET", "chat:roles", target, role]]);
		}
		return cleanName(parts[0]) + " is now " + role + ".";
	}

	if (command === "unlink") {
		if (!ctx.admin) {
			return DENIED;
		}
		const target = await findUid(parts[0]);
		if (!target) {
			return "Unknown player.";
		}
		await redis([
			["HDEL", "chat:tokens", target],
			["HDEL", "chat:names", cleanName(parts[0]).toLowerCase()],
			["HDEL", "chat:unames", target],
		]);
		return cleanName(parts[0]) + " was reset.";
	}

	return "Unknown command. /help";
}

async function handleGet(req, res) {
	if (req.query.profile) {
		const target = cleanId(req.query.profile);
		const [flat, name, role] = await redis([
			["HGETALL", "chat:profile:" + target],
			["HGET", "chat:unames", target],
			["HGET", "chat:roles", target],
		]);
		const info = Object.fromEntries(pairs(flat));
		return res.status(200).json({
			name: name || "",
			role: role || "member",
			msgs: Number(info.msgs) || 0,
			since: Number(info.since) || 0,
			place: info.place || "",
		});
	}

	const known = Number(req.query.t);
	const [peek] = await redis([["GET", "chat:tick"]]);
	if (Number.isFinite(known) && Number(peek) === known) {
		return res.status(200).json({ same: true, tick: known });
	}

	const uid = cleanId(req.headers["x-uid"]);
	const secret = String(req.headers["x-token"] || "").slice(0, 100);
	if (!uid || secret.length < 16) {
		return res.status(401).json({ error: "identity" });
	}

	const gid = cleanId(req.query.gid);
	const cursors = parseCursors(req.query.c);

	const [tick, , bound, roomIds, inviteFlat, role, globalRaw, gameRaw] = await redis([
		["GET", "chat:tick"],
		["HSETNX", "chat:tokens", uid, secret],
		["HGET", "chat:tokens", uid],
		["SMEMBERS", "chat:uroom:" + uid],
		["HGETALL", "chat:inv:" + uid],
		["HGET", "chat:roles", uid],
		["LRANGE", channelKey("global"), 0, KEEP - 1],
		["LRANGE", channelKey("game", gid), 0, KEEP - 1],
	]);

	if (bound !== secret) {
		return res.status(403).json({ error: "identity" });
	}

	const ids = (roomIds || []).map(cleanId).filter(Boolean);
	const roomCommands = ids.flatMap((id) => [
		["HGET", "chat:room:" + id, "name"],
		["LRANGE", "chat:msgs:room:" + id, 0, KEEP - 1],
	]);
	const roomResults = roomCommands.length ? await redis(roomCommands) : [];

	const channels = {
		global: collect(globalRaw, Number(cursors.global)),
		game: collect(gameRaw, Number(cursors.game)),
	};
	const rooms = [];
	ids.forEach((id, index) => {
		const name = roomResults[index * 2];
		if (!name) {
			return;
		}
		rooms.push({ id, name });
		channels["room:" + id] = collect(roomResults[index * 2 + 1], Number(cursors["room:" + id]));
	});

	const invites = pairs(inviteFlat).map(([id, value]) => {
		const [room, from] = String(value).split("|");
		return { id, room, from };
	});

	return res.status(200).json({
		tick: Number(tick) || 0,
		me: { role: role || "member" },
		channels,
		rooms,
		invites,
	});
}

async function handlePost(req, res) {
	let body = req.body;
	if (typeof body === "string") {
		body = parse(body);
	}
	if (!body || typeof body !== "object") {
		return res.status(400).json({ error: "body" });
	}

	const name = cleanName(body.name);
	const auth = await authenticate(req, name);
	if (auth.error) {
		return res.status(403).json({ error: auth.error });
	}

	const uid = auth.uid;
	const adminKey = process.env.ADMIN_KEY;
	const admin = Boolean(adminKey) && req.headers["x-admin"] === adminKey;
	const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();

	const [bannedUid, bannedIp, ttl, storedRole] = await redis([
		["SISMEMBER", "chat:ban:uids", uid],
		["SISMEMBER", "chat:ban:ips", ip],
		["TTL", "chat:timeout:" + uid],
		["HGET", "chat:roles", uid],
	]);

	if (!admin) {
		if (bannedUid || bannedIp) {
			return res.status(403).json({ error: "banned" });
		}
		if (ttl > 0) {
			return res.status(403).json({ error: "timeout", seconds: ttl });
		}
	} else if (storedRole !== "admin") {
		await redis([["HSET", "chat:roles", uid, "admin"]]);
	}

	const ctx = {
		uid,
		name,
		admin,
		role: admin ? "admin" : storedRole || "member",
		staff: admin || storedRole === "mod",
	};

	const channel = typeof body.channel === "string" ? body.channel : "global";
	const key = channelKey(channel, body.gid);

	if (body.command) {
		const info = await runCommand(ctx, { ...body, channel }, key);
		await redis([["INCR", "chat:tick"]]);
		return res.status(200).json({ ok: true, info });
	}

	const text = String(body.text || "").trim().slice(0, MAX_TEXT);
	if (!text) {
		return res.status(400).json({ error: "empty" });
	}

	const roomId = roomOf(channel);
	if (roomId) {
		const [member] = await redis([["SISMEMBER", "chat:room:" + roomId + ":members", uid]]);
		if (!member) {
			return res.status(403).json({ error: "room" });
		}
	}

	if (!ctx.staff) {
		const [hits] = await redis([
			["INCR", "rl:" + ip],
			["EXPIRE", "rl:" + ip, WINDOW_SECONDS, "NX"],
		]);
		if (hits > WINDOW_LIMIT) {
			return res.status(429).json({ error: "rate" });
		}

		const [slow] = await redis([["GET", "chat:slow:" + key]]);
		const seconds = Number(slow) || 0;
		if (seconds > 0) {
			const [set] = await redis([["SET", "chat:cd:" + uid + ":" + key, "1", "NX", "EX", seconds]]);
			if (set !== "OK") {
				return res.status(429).json({ error: "slow", seconds });
			}
		}
	}

	await push(key, { name, uid, role: ctx.role, text });
	const stats = [
		["HINCRBY", "chat:profile:" + uid, "msgs", 1],
		["HSETNX", "chat:profile:" + uid, "since", Math.floor(Date.now() / 1000)],
		["HSET", "chat:ips", uid, ip],
		["INCR", "chat:tick"],
	];
	const place = cleanId(body.pid);
	if (place) {
		stats.push(["HSET", "chat:profile:" + uid, "place", place]);
	}
	await redis(stats);

	return res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
	if (!base || !token) {
		return res.status(500).json({ error: "redis env missing" });
	}

	try {
		if (req.method === "GET") {
			return await handleGet(req, res);
		}
		if (req.method === "POST") {
			return await handlePost(req, res);
		}
		return res.status(405).end();
	} catch (error) {
		return res.status(500).json({ error: String((error && error.message) || error) });
	}
};
