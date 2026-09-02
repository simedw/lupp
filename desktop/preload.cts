import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ReviewAPI } from "./types.js";
import type { AnalysisUpdate } from "./agent-queue.js";

const reviewAPI: ReviewAPI = {
  chooseRepository: () => ipcRenderer.invoke("repository:choose"),
  initialRepository: () => ipcRenderer.invoke("repository:initial"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  startSession: (metadata) => ipcRenderer.invoke("session:start", metadata),
  saveAndTranscribe: (payload) => ipcRenderer.invoke("segment:transcribe", payload),
  enqueueAnalysis: (payload) => ipcRenderer.invoke("analysis:enqueue", payload),
  updateObservation: (payload) => ipcRenderer.invoke("observation:update", payload),
  deleteObservation: (id) => ipcRenderer.invoke("observation:delete", id),
  onAnalysisUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, update: AnalysisUpdate) => callback(update);
    ipcRenderer.on("analysis:update", listener);
    return () => ipcRenderer.removeListener("analysis:update", listener);
  }
};
contextBridge.exposeInMainWorld("reviewAPI", reviewAPI);
