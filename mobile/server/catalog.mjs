import { readFileSync } from "node:fs";
export const referenceModels = [
	["glm-53", "GLM-5.3 (max)", "Z.ai"],
	["kimi-k3", "Kimi K3 (max)", "Moonshot AI"],
	["glm-flash", "GLM-5.3-Flash", "Z.ai"],
	["qwen-large", "Qwen3.8 2.4T A95B", "Qwen"],
	["deepseek-flash", "DeepSeek V4.1 Flash (max)", "DeepSeek"],
	["deepseek-pro", "DeepSeek V4 Pro 0813 (max)", "DeepSeek"],
	["qwen-small", "Qwen3.8 27B (xhigh)", "Qwen"],
	["minimax", "MiniMax-M3", "MiniMax"],
	["inkling", "Inkling", "Thinking Machines"],
	["nemotron", "Nemotron 3 Ultra", "NVIDIA"],
	["muse", "Muse Glimmer (high)", "Meta"],
	["mistral", "Mistral Medium 3.5", "Mistral"],
	["gpt-oss", "gpt-oss-120b (high)", "OpenAI"],
];
export function loadCatalog(path) {
	const entries = JSON.parse(readFileSync(path, "utf8"));
	return referenceModels.map(([id, name, lab]) => {
		const e = entries[id] || {};
		return {
			id,
			name,
			lab,
			providerId: typeof e.providerId === "string" ? e.providerId : null,
			input: Number(e.inputPerMillion),
			output: Number(e.outputPerMillion),
			verified: e.openWeightsVerified === true,
			free: e.free === true,
			reasoningEffort: ["max", "xhigh", "high", "medium", "low", "none"].includes(e.reasoningEffort)
				? e.reasoningEffort
				: undefined,
		};
	});
}
export function enabled(m) {
	return (
		!!m.providerId &&
		m.verified &&
		Number.isFinite(m.input) &&
		Number.isFinite(m.output) &&
		m.input >= 0 &&
		m.output >= 0
	);
}
