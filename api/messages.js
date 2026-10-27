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

async function handle(req, res) {
	if (process.env.CHAT_KEY && req.headers["x-key"] !== process.env.CHAT_KEY) {
		return res.status(401).json({ error: "key" });
	}

	if (req.method === "GET") {
		const after = Number(req.query.after);
		const floor = Number.isNaN(after) ? -1 : after;
		const [last, raw] = await redis([
			["GET", "chat:id"],
			["LRANGE", "chat:msgs", 0, KEEP - 1],
		]);

		let messages = (raw || []).map((item) => JSON.parse(item)).filter((m) => m.id > floor);
		if (floor < 0) {
			messages = messages.slice(0, 20);
		}
		messages.reverse();

		return res.status(200).json({ messages, last: Number(last) || 0 });
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

		if (!body || typeof body.name !== "string" || typeof body.text !== "string") {
			return res.status(400).json({ error: "body" });
		}

		const name = body.name.trim().slice(0, MAX_NAME);
		const text = body.text.trim().slice(0, MAX_TEXT);
		if (!name || !text) {
			return res.status(400).json({ error: "empty" });
		}

		const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
		const [hits] = await redis([
			["INCR", "rl:" + ip],
			["EXPIRE", "rl:" + ip, WINDOW_SECONDS, "NX"],
		]);
		if (hits > WINDOW_LIMIT) {
			return res.status(429).json({ error: "rate" });
		}

		const [id] = await redis([["INCR", "chat:id"]]);
		await redis([
			["LPUSH", "chat:msgs", JSON.stringify({ id, name, text })],
			["LTRIM", "chat:msgs", 0, KEEP - 1],
		]);

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
		return res.status(500).json({ error: String(error && error.message || error) });
	}
};
