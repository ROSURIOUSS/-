"""Individual online reinforcement learning, entirely standard-library/CPU.

Inherited recurrent weights stay immutable during a lifetime. Each creature owns
an adaptive linear motor head over its 16 inputs + 8 recurrent activations + bias.
A clipped Gaussian score-function update uses the actual step outcome and a
moving reward baseline. This is a small reactive policy, not language reasoning.
"""
from __future__ import annotations

import copy
import math


try:
    from math import sumprod as dot
except ImportError:
    from operator import mul
    def dot(left, right):
        return sum(map(mul, left, right))

FEATURES, ACTIONS = 25, 4
PARAMETERS = FEATURES * ACTIONS
SIGMA = 0.15
WEIGHT_LIMIT = 1.5


def new_experience():
    return {"enabled": True, "weights": [0.0] * PARAMETERS, "trace": [],
            "updates": 0, "baseline": 0.0, "reward": 0.0,
            "residual": [0.0] * ACTIONS, "exploration": [0.0] * ACTIONS}


def _normal_noise(noise, updates):
    # Four deterministic approximately independent normals from the world's
    # already sampled noise input. No shared learner and no observer-side RNG.
    mask = (1 << 64) - 1
    seed = int((max(-1, min(1, noise)) + 1) * 0.5 * ((1 << 53) - 1)) ^ (updates * 0x9E3779B97F4A7C15)
    uniforms = []
    for i in range(4):
        z = (seed + (i + 1) * 0x9E3779B97F4A7C15) & mask
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & mask
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & mask
        z ^= z >> 31
        uniforms.append(((z >> 11) + 0.5) / (1 << 53))
    result = []
    for i in (0, 2):
        radius = math.sqrt(-2 * math.log(uniforms[i]))
        angle = math.tau * uniforms[i + 1]
        result.extend((radius * math.cos(angle), radius * math.sin(angle)))
    return [SIGMA * max(-3.0, min(3.0, value)) for value in result]


def act(state, inputs, hidden, logits):
    features = [max(-1.0, min(1.0, value)) for value in inputs] + list(hidden) + [1.0]
    norm = math.sqrt(sum(value * value for value in features))
    features = [value / norm for value in features]
    noise = _normal_noise(inputs[11], state["updates"]) if state["enabled"] and state["updates"] else [0.0] * ACTIONS
    residual, output, trace = [], [], []
    for action, logit in enumerate(logits):
        start = action * FEATURES
        delta = sum(w * x for w, x in zip(state["weights"][start:start + FEATURES], features))
        delta = max(-1.5, min(1.5, delta))
        residual.append(delta)
        output.append(math.tanh(logit + delta + noise[action]))
        # Clipped offsets have zero derivative outside their linear interval.
        score = noise[action] / (SIGMA * SIGMA) if abs(delta) < 1.5 else 0.0
        trace.extend(score * value for value in features)
    state["residual"], state["exploration"] = residual, noise
    state["trace"] = trace if state["enabled"] else []
    return output


def learn(state, reward):
    if not state["enabled"] or not state["trace"]:
        return
    reward = max(-1.0, min(1.0, reward))
    advantage = max(-1.0, min(1.0, reward - state["baseline"]))
    for i, gradient in enumerate(state["trace"]):
        change = max(-0.025, min(0.025, 0.012 * advantage * gradient))
        state["weights"][i] = max(-WEIGHT_LIMIT, min(WEIGHT_LIMIT, state["weights"][i] * 0.9999 + change))
    state["baseline"] = state["baseline"] * 0.95 + reward * 0.05
    state["reward"] = reward
    state["updates"] = min(10**12, state["updates"] + 1)
    state["trace"] = []


def outcome_reward(energy_before, energy_after, health_before, health_after, blocked, births, birth_cost):
    # Reproduction costs are compensated so a successful birth isn't mistaken
    # for starvation; wounds received later in the sequential step are included.
    value = (energy_after - energy_before + births * birth_cost) / 12
    value -= max(0.0, health_before - health_after) / 25
    value -= 0.35 if blocked else 0.0
    value += min(1, births) * 0.25
    return max(-1.0, min(1.0, value))


def summary(state):
    return {"enabled": state["enabled"], "updates": state["updates"],
            "reward": round(state["reward"], 4), "baseline": round(state["baseline"], 4),
            "adaptation": round(math.sqrt(sum(w * w for w in state["weights"])), 4),
            "exploration": [round(v, 4) for v in state["exploration"]]}


def validate_experience(state):
    template = new_experience()
    if not isinstance(state, dict) or state.keys() != template.keys():
        raise ValueError("Неверное состояние индивидуального обучения")
    if type(state["enabled"]) is not bool or type(state["updates"]) is not int or not 0 <= state["updates"] <= 10**12:
        raise ValueError("Неверные счётчики обучения")
    def number(value, limit):
        if type(value) not in (int, float) or not math.isfinite(value) or not -limit <= value <= limit:
            raise ValueError("Недопустимое число в обучении")
    for key, length, limit in (("weights", PARAMETERS, WEIGHT_LIMIT), ("residual", ACTIONS, 1.5),
                               ("exploration", ACTIONS, SIGMA * 3 + 1e-12)):
        values = state[key]
        if not isinstance(values, list) or len(values) != length:
            raise ValueError("Неверный размер обучаемого слоя")
        for value in values:
            number(value, limit)
    trace = state["trace"]
    if not isinstance(trace, list) or len(trace) not in (0, PARAMETERS):
        raise ValueError("Неверный след решения")
    for value in trace:
        number(value, 21)
    for key in ("reward", "baseline"):
        number(state[key], 1)
    return copy.deepcopy(state)


def recurrent_decision(brain, memory, experience, inputs):
    """Shared computation, private weights/memory/experience for each organism."""
    hidden = []
    for offset in range(0, 200, 25):
        total = dot(inputs, brain[offset:offset + 16])
        total += dot(memory, brain[offset + 16:offset + 24])
        hidden.append(math.tanh(total + brain[offset + 24]))
    logits = [dot(hidden, brain[offset:offset + 8]) + brain[offset + 8]
              for offset in range(200, 236, 9)]
    return hidden, act(experience, inputs, hidden, logits)
