// Operator-maintained allowlist. Configure local model names here, not in job arguments/env.
// A name alone is not proof of a daemon's behavior; use an operator-controlled local daemon.
export const LOCAL_MODELS = Object.freeze(["qwen2.5-coder:7b", "qwen3:8b"]);
