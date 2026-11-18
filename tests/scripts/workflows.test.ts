import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Job = {
	environment?: string | { name: string };
	permissions?: Record<string, string>;
	steps?: { uses?: string; run?: string }[];
	uses?: string;
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const WORKFLOWS = ".github/workflows";
const files = readdirSync(WORKFLOWS).filter((file) => file.endsWith(".yml"));
const text = (file: string) => readFileSync(`${WORKFLOWS}/${file}`, "utf8");
const workflow = (file: string) => parse(text(file)) as Workflow;
const environmentOf = (job: Job) =>
	typeof job.environment === "string" ? job.environment : job.environment?.name;
const logsInToAzure = (job: Job) =>
	(job.steps ?? []).some((step) => step.uses?.startsWith("azure/login@"));

describe("the Release workflow", () => {
	const release = workflow("release.yml");

	it("runs only when a person starts it", () => {
		expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
	});

	it("logs in to Azure only from the prod-cd job, behind Environment prod", () => {
		const azure = Object.entries(release.jobs).filter(([, job]) => logsInToAzure(job));
		expect(azure.map(([name]) => name)).toEqual(["prod-cd"]);
		expect(environmentOf(release.jobs["prod-cd"] as Job)).toBe("prod");
	});

	it("rolls prod only after the image is published, and checks it is rolling prod", () => {
		const job = release.jobs["prod-cd"] as Job & { needs: string[] };
		expect(job.needs).toContain("publish");
		const script = (job.steps ?? []).map((step) => step.run ?? "").join("\n");
		expect(script).toContain('"${env_name}" != "prod"');
		expect(script).toContain("az containerapp update");
		expect(script).not.toMatch(/terraform/);
	});

	it("cuts releases from main only", () => {
		expect(text("release.yml")).toContain('"${GITHUB_REF}" != "refs/heads/main"');
	});

	it("publishes the docs from the release commit", () => {
		const docs = release.jobs.docs as Job & { with: { ref: string } };
		expect(docs.uses).toBe("./.github/workflows/docs.yml");
		expect(docs.with.ref).toBe("${{ needs.bump.outputs.sha }}");
	});
});

describe("every workflow", () => {
	it("names pixel-phone-prod only in the Release workflow", () => {
		for (const file of files.filter((name) => name !== "release.yml")) {
			expect(text(file), file).not.toContain("pixel-phone-prod");
		}
	});

	it("uses Environment prod only in the Release workflow", () => {
		for (const file of files.filter((name) => name !== "release.yml")) {
			for (const [name, job] of Object.entries(workflow(file).jobs)) {
				expect(environmentOf(job), `${file} ${name}`).not.toBe("prod");
			}
		}
	});
});
