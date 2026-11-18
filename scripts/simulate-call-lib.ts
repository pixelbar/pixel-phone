/** The option parsing and checks for `just simulate-call`, kept pure for tests. */

export type SimulateOptions = {
	acceptAfter?: number;
	acceptVia: "home-assistant" | "pixel";
	hangupAfter?: number;
	secondCall: boolean;
	haDown: boolean;
	queueDown: boolean;
	/** ACCEPT_WINDOW_SECONDS for the app (5–120). Short windows make timeouts quick. */
	window: number;
	/** Fail (exit 1) unless the first call ends this way. */
	expect?: "ended" | "missed";
	port: number;
};

export const USAGE = `just simulate-call [options]

  --accept-after <s>   accept after this many seconds (default: never)
  --accept-via pixel   accept as Pixel, by call ID (default: home-assistant, "current")
  --hangup-after <s>   the caller hangs up after this many seconds
  --second-call        a second call arrives while the first is active
  --ha-down            Home Assistant doesn't answer
  --queue-down         the queue can't be reached
  --window <s>         the accept window (default 15)
  --expect ended|missed  exit 1 unless the first call ends this way (for CI)
  --port <n>           the app's port (default 3100)

Needs Azurite: just azurite.`;

function seconds(flag: string, value: string | undefined): number {
	const n = Number(value);
	if (value === undefined || !Number.isFinite(n) || n < 0 || n > 300) {
		throw new Error(`${flag} needs a number of seconds`);
	}
	return n;
}

export function parseOptions(argv: readonly string[]): SimulateOptions {
	const options: SimulateOptions = {
		acceptVia: "home-assistant",
		secondCall: false,
		haDown: false,
		queueDown: false,
		window: 15,
		port: 3100,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => argv[++i];
		switch (flag) {
			case "--accept-after":
				options.acceptAfter = seconds(flag, next());
				break;
			case "--accept-via": {
				const via = next();
				if (via !== "pixel" && via !== "home-assistant") {
					throw new Error("--accept-via is pixel or home-assistant");
				}
				options.acceptVia = via;
				break;
			}
			case "--hangup-after":
				options.hangupAfter = seconds(flag, next());
				break;
			case "--second-call":
				options.secondCall = true;
				break;
			case "--ha-down":
				options.haDown = true;
				break;
			case "--queue-down":
				options.queueDown = true;
				break;
			case "--window": {
				const w = seconds(flag, next());
				if (w < 5 || w > 120) throw new Error("--window is 5 to 120 seconds");
				options.window = w;
				break;
			}
			case "--expect": {
				const e = next();
				if (e !== "ended" && e !== "missed") throw new Error("--expect is ended or missed");
				options.expect = e;
				break;
			}
			case "--port": {
				const port = Number(next());
				if (!Number.isInteger(port) || port < 1024 || port > 65535) {
					throw new Error("--port is 1024 to 65535");
				}
				options.port = port;
				break;
			}
			case "--help":
			case "-h":
				throw new Error(USAGE);
			default:
				throw new Error(`Unknown option ${flag}.\n\n${USAGE}`);
		}
	}
	return options;
}

/** What should happen, given the options: for the summary line. */
export function predictedOutcome(o: SimulateOptions): "ended" | "missed" {
	const accepts = o.acceptAfter !== undefined && o.acceptAfter < o.window;
	const hangsUpFirst =
		o.hangupAfter !== undefined && (o.acceptAfter === undefined || o.hangupAfter < o.acceptAfter);
	return accepts && !hangsUpFirst ? "ended" : "missed";
}

/** "+1.23s" for the timeline. */
export function stamp(ms: number): string {
	return `+${(ms / 1000).toFixed(2).padStart(6)}s`;
}
