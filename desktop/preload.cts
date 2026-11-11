import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ActionUpdate, QuickUpdate, RepositoryChange, ReviewAPI } from "./types.js";
import type { AnalysisUpdate } from "./agent-queue.js";

const reviewAPI: ReviewAPI = {
  chooseRepository: () => ipcRenderer.invoke("repository:choose"),
  initialRepository: () => ipcRenderer.invoke("repository:initial"),
  loadDiff: (source) => ipcRenderer.invoke("repository:diff", source),
  reloadRepository: () => ipcRenderer.invoke("repository:reload"),
  setFileReviewed: (file) => ipcRenderer.invoke("file:reviewed", file),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  startSession: (metadata) => ipcRenderer.invoke("session:start", metadata),
  saveAndTranscribe: (payload) => ipcRenderer.invoke("segment:transcribe", payload),
  enqueueAnalysis: (payload) => ipcRenderer.invoke("analysis:enqueue", payload),
  updateObservation: (payload) => ipcRenderer.invoke("observation:update", payload),
  deleteObservation: (id) => ipcRenderer.invoke("observation:delete", id),
  rerunAnalysis: (id) => ipcRenderer.invoke("analysis:rerun", id),
  replyToFinding: (payload) => ipcRenderer.invoke("analysis:reply", payload),
  applyAction: (selection) => ipcRenderer.invoke("action:apply", selection),
  onActionUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, update: ActionUpdate) => callback(update);
    ipcRenderer.on("action:update", listener);
    return () => ipcRenderer.removeListener("action:update", listener);
  },
  dismissAction: (selection) => ipcRenderer.invoke("action:dismiss", selection),
  copyActions: (selection) => ipcRenderer.invoke("actions:copy", selection),
  onQuickUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, update: QuickUpdate) => callback(update);
    ipcRenderer.on("quick:update", listener);
    return () => ipcRenderer.removeListener("quick:update", listener);
  },
  onRepositoryChange: (callback) => {
    const listener = (_event: IpcRendererEvent, change: RepositoryChange) => callback(change);
    ipcRenderer.on("repository:changed", listener);
    return () => ipcRenderer.removeListener("repository:changed", listener);
  },
  onAnalysisUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, update: AnalysisUpdate) => callback(update);
    ipcRenderer.on("analysis:update", listener);
    return () => ipcRenderer.removeListener("analysis:update", listener);
  }
};
contextBridge.exposeInMainWorld("reviewAPI", reviewAPI);
