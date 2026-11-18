/**
 * A fake Home Assistant on a real local port: records `input_boolean.turn_on/turn_off`
 * calls and keeps the helper's state, so the harness (#17) and tests can watch the ringer.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeHomeAssistant = {
	url: string;
	token: string;
	/** Every service call, in order: "turn_on" / "turn_off" with the entity. */
	calls: { service: string; entityId: string; at: Date }[];
	/** The helpers' states. */
	states: Map<string, "on" | "off">;
	/** Set to reply with this status, or "hang" to never reply, or "down" to drop. */
	mode: "ok" | "hang" | "down" | number;
	onCall?: (service: string, entityId: string) => void;
	close(): Promise<void>;
};

export async function startFakeHomeAssistant(token = "fake-ha-token"): Promise<FakeHomeAssistant> {
	const fake = {
		calls: [] as FakeHomeAssistant["calls"],
		states: new Map<string, "on" | "off">(),
		mode: "ok" as FakeHomeAssistant["mode"],
		onCall: undefined as FakeHomeAssistant["onCall"],
	};
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			if (fake.mode === "hang") return;
			if (fake.mode === "down") {
				req.socket.destroy();
				return;
			}
			if (req.headers.authorization !== `Bearer ${token}`) {
				res.writeHead(401).end("401: Unauthorized");
				return;
			}
			if (typeof fake.mode === "number") {
				res.writeHead(fake.mode).end();
				return;
			}
			const match = /^\/api\/services\/input_boolean\/(turn_on|turn_off)$/.exec(req.url ?? "");
			if (req.method !== "POST" || !match?.[1]) {
				res.writeHead(404).end();
				return;
			}
			const { entity_id } = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
				entity_id?: string;
			};
			if (!entity_id) {
				res.writeHead(400).end();
				return;
			}
			const service = match[1];
			fake.calls.push({ service, entityId: entity_id, at: new Date() });
			fake.states.set(entity_id, service === "turn_on" ? "on" : "off");
			fake.onCall?.(service, entity_id);
			res.writeHead(200, { "content-type": "application/json" }).end("[]");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return Object.assign(fake, {
		url: `http://127.0.0.1:${port}`,
		token,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	});
}
