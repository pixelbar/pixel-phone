/**
 * A fake of the bits of Telnyx's REST API pixel-phone uses, on a real local HTTP port, so
 * tests exercise the real HTTP client code without touching the live account.
 *
 * - Call Control applications and phone numbers (`just telnyx-sync`, #8).
 * - Call Control commands, `POST /v2/calls/{id}/actions/{action}` (the Telnyx adapter, #10).
 *
 * Every request is recorded, including its Authorization header, so tests can check the
 * key is sent and nowhere else.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeApplication = Record<string, unknown> & { id: string; application_name: string };
export type FakeNumber = { id: string; phone_number: string; connection_id: string | null };

export type RecordedRequest = {
	method: string;
	path: string;
	authorization: string | undefined;
	body: unknown;
};

/** What the next call command gets back, instead of 200. */
export type CommandReply = { status: number; body?: unknown } | "hang" | "reset";

export type FakeTelnyxApi = {
	url: string;
	applications: FakeApplication[];
	numbers: FakeNumber[];
	requests: RecordedRequest[];
	/** Replies for the next call commands, used in order. Empty: 200 `{ data: { result: "ok" } }`. */
	commandReplies: CommandReply[];
	/** Only requests with `Authorization: Bearer <apiKey>` are allowed; others get 401. */
	apiKey: string;
	/** Called after each successful call command (the harness answers it with a webhook). */
	onCommand:
		| ((callControlId: string, action: string, body: Record<string, unknown>) => void)
		| undefined;
	close(): Promise<void>;
};

function send(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, code: string, title: string) {
	send(res, status, { errors: [{ code, title, detail: title }] });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	return text === "" ? undefined : JSON.parse(text);
}

export async function startFakeTelnyxApi(apiKey = "KEYFAKE_test_only"): Promise<FakeTelnyxApi> {
	const state = {
		applications: [] as FakeApplication[],
		numbers: [] as FakeNumber[],
		requests: [] as RecordedRequest[],
		commandReplies: [] as CommandReply[],
		onCommand: undefined as FakeTelnyxApi["onCommand"],
	};

	const server: Server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://fake");
			const body = await readBody(req);
			state.requests.push({
				method: req.method ?? "GET",
				path: url.pathname + url.search,
				authorization: req.headers.authorization,
				body,
			});
			if (req.headers.authorization !== `Bearer ${apiKey}`) {
				return error(res, 401, "10009", "Authentication failed");
			}
			const parts = url.pathname.split("/").filter(Boolean);

			// Call Control commands.
			if (req.method === "POST" && parts[1] === "calls" && parts[3] === "actions") {
				const reply = state.commandReplies.shift();
				if (reply === "hang") return; // never answers; the client's time limit fires
				if (reply === "reset") {
					req.socket.destroy();
					return;
				}
				if (reply) return send(res, reply.status, reply.body ?? {});
				send(res, 200, { data: { result: "ok" } });
				state.onCommand?.(
					decodeURIComponent(parts[2] ?? ""),
					parts[4] ?? "",
					(body ?? {}) as Record<string, unknown>,
				);
				return;
			}

			if (parts[1] === "call_control_applications") {
				const id = parts[2];
				if (req.method === "GET" && id === undefined) {
					const name = url.searchParams.get("filter[application_name][contains]") ?? "";
					return send(res, 200, {
						data: state.applications.filter((a) => a.application_name.includes(name)),
					});
				}
				if (req.method === "POST" && id === undefined) {
					const app = { ...(body as object), id: randomUUID() } as FakeApplication;
					state.applications.push(app);
					return send(res, 201, { data: app });
				}
				const app = state.applications.find((a) => a.id === id);
				if (!app) return error(res, 404, "10005", "Resource not found");
				if (req.method === "PATCH") {
					Object.assign(app, body as object);
					return send(res, 200, { data: app });
				}
			}

			if (parts[1] === "phone_numbers") {
				const id = parts[2];
				if (req.method === "GET" && id === undefined) {
					const wanted = url.searchParams.get("filter[phone_number]");
					return send(res, 200, {
						data: state.numbers.filter((n) => wanted === null || n.phone_number === wanted),
					});
				}
				const number = state.numbers.find((n) => n.id === id);
				if (!number) return error(res, 404, "10005", "Resource not found");
				if (req.method === "PATCH") {
					Object.assign(number, body as object);
					return send(res, 200, { data: number });
				}
			}

			return error(res, 404, "10005", "Resource not found");
		})();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		get applications() {
			return state.applications;
		},
		set applications(value) {
			state.applications = value;
		},
		get numbers() {
			return state.numbers;
		},
		set numbers(value) {
			state.numbers = value;
		},
		get requests() {
			return state.requests;
		},
		set requests(value) {
			state.requests = value;
		},
		get commandReplies() {
			return state.commandReplies;
		},
		set commandReplies(value) {
			state.commandReplies = value;
		},
		get onCommand() {
			return state.onCommand;
		},
		set onCommand(value) {
			state.onCommand = value;
		},
		apiKey,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
