const MAX_NAME = 24;
const MAX_TEXT = 200;
const KEEP = 50;
const WINDOW_SECONDS = 5;
const WINDOW_LIMIT = 6;

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

function cleanId(value) {
	return String(value || "").replace(/[^\w-]/g, "").slice(0, 40);
}

function channelKey(channel, gameId) {
	if (channel === "game") {
		return "chat:msgs:game:" + (cleanId(gameId) || "none");
	}
	return "chat:msgs:global";
}

function collect(raw, after) {
	const floor = Number.isNaN(after) ? -1 : after;
	let messages = (raw || []).map((item) => JSON.parse(item)).filter((m) => m.id > floor);
	if (floor < 0) {
		messages = messages.slice(0, 20);
	}
	messages.reverse();
	const last = messages.reduce((max, m) => Math.max(max, m.id), Math.max(floor, 0));
	return { messages, last };
}

async function push(key, entry) {
	const [id] = await redis([["INCR", "chat:id"]]);
	await redis([
		["LPUSH", key, JSON.stringify({ id, ...entry })],
		["LTRIM", key, 0, KEEP - 1],
	]);
}

async function runCommand(body, name) {
	const arg = String(body.arg || "").trim();
	const target = arg.toLowerCase().slice(0, MAX_NAME);
	const key = channelKey(body.channel, body.gid);

	if (body.command === "clear") {
		await redis([["DEL", key]]);
		await push(key, { name, text: "", kind: "clear" });
		return "Geleert.";
	}

	if (body.command === "announce") {
		if (!arg) {
			return "Text fehlt.";
		}
		await push("chat:msgs:global", { name, text: arg.slice(0, MAX_TEXT), kind: "announce" });
		return "Ankündigung gesendet.";
	}

	if (body.command === "bans") {
		const [names] = await redis([["SMEMBERS", "chat:ban:names"]]);
		return names && names.length ? "Gebannt: " + names.join(", ") : "Niemand gebannt.";
	}

	if (body.command === "ban" || body.command === "unban") {
		if (!target) {
			return "Name fehlt.";
		}

		const [ip] = await redis([["HGET", "chat:ips", target]]);

		if (body.command === "ban") {
			const commands = [["SADD", "chat:ban:names", target]];
			if (ip) {
				commands.push(["SADD", "chat:ban:ips", ip]);
			}
			await redis(commands);
			return target + (ip ? " gebannt." : " gebannt (IP unbekannt).");
		}

		const commands = [["SREM", "chat:ban:names", target]];
		if (ip) {
			commands.push(["SREM", "chat:ban:ips", ip]);
		}
		await redis(commands);
		return target + " entbannt.";
	}

	return "Unbekannter Befehl.";
}

async function handle(req, res) {
	if (process.env.CHAT_KEY && req.headers["x-key"] !== process.env.CHAT_KEY) {
		return res.status(401).json({ error: "key" });
	}

	const adminKey = process.env.ADMIN_KEY;
	const admin = Boolean(adminKey) && req.headers["x-admin"] === adminKey;

	if (req.method === "GET") {
		const gid = cleanId(req.query.gid);
		const [globalRaw, gameRaw] = await redis([
			["LRANGE", channelKey("global"), 0, KEEP - 1],
			["LRANGE", channelKey("game", gid), 0, KEEP - 1],
		]);

		return res.status(200).json({
			global: collect(globalRaw, Number(req.query.ag)),
			game: collect(gameRaw, Number(req.query.am)),
		});
	}

	if (req.method === "POST") {
		let body = req.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {
				return res.status(400).json({ error: "body" });
			}
		}

		if (!body || typeof body.name !== "string") {
			return res.status(400).json({ error: "body" });
		}

		const name = body.name.trim().slice(0, MAX_NAME);
		if (!name) {
			return res.status(400).json({ error: "empty" });
		}

		if (body.command) {
			if (!admin) {
				return res.status(403).json({ error: "admin" });
			}
			const info = await runCommand(body, name);
			return res.status(200).json({ ok: true, info });
		}

		if (typeof body.text !== "string") {
			return res.status(400).json({ error: "body" });
		}

		const text = body.text.trim().slice(0, MAX_TEXT);
		if (!text) {
			return res.status(400).json({ error: "empty" });
		}

		const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
		const lowered = name.toLowerCase();

		if (!admin) {
			const [nameBanned, ipBanned] = await redis([
				["SISMEMBER", "chat:ban:names", lowered],
				["SISMEMBER", "chat:ban:ips", ip],
			]);
			if (nameBanned || ipBanned) {
				return res.status(403).json({ error: "banned" });
			}

			const [hits] = await redis([
				["INCR", "rl:" + ip],
				["EXPIRE", "rl:" + ip, WINDOW_SECONDS, "NX"],
			]);
			if (hits > WINDOW_LIMIT) {
				return res.status(429).json({ error: "rate" });
			}

			await redis([["HSET", "chat:ips", lowered, ip]]);
		}

		await push(channelKey(body.channel, body.gid), { name, text, ...(admin ? { admin: true } : {}) });

		return res.status(200).json({ ok: true });
	}

	return res.status(405).end();
}

module.exports = async (req, res) => {
	if (!base || !token) {
		return res.status(500).json({ error: "redis env missing" });
	}

	try {
		return await handle(req, res);
	} catch (error) {
		return res.status(500).json({ error: String((error && error.message) || error) });
	}
};
