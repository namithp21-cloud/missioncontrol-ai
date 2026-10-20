import { api } from "./api.js";

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export const state = {
  projects: [],
  members: [],
  agent: null,
  currentProjectId: null,
  pendingPrompt: null,
};

function readStored() {
  try { return localStorage.getItem("mc.project"); } catch { return null; }
}
function writeStored(id) {
  try { if (id) localStorage.setItem("mc.project", id); else localStorage.removeItem("mc.project"); } catch { /* storage unavailable */ }
}

export function currentProject() {
  return state.projects.find((p) => p.id === state.currentProjectId) || null;
}

export function setCurrentProject(id) {
  state.currentProjectId = id;
  writeStored(id);
  emit("project-changed", id);
}

export async function refreshCore() {
  const [projects, members, agent] = await Promise.all([api.get("/api/projects"), api.get("/api/team"), api.get("/api/agent/status")]);
  state.projects = projects;
  state.members = members;
  state.agent = agent;
  const stored = state.currentProjectId || readStored();
  if (!projects.some((p) => p.id === stored)) {
    const next = projects.find((p) => p.status === "active") || projects[0] || null;
    state.currentProjectId = next ? next.id : null;
    writeStored(state.currentProjectId);
  } else state.currentProjectId = stored;
  emit("core-refreshed");
}

export const memberById = (id) => state.members.find((m) => m.id === id) || null;
