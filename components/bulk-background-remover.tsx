"use client";

import JSZip from "jszip";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileArchive,
  ImageIcon,
  Loader2,
  Lock,
  Play,
  Sparkles,
  TimerReset,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Config } from "@imgly/background-removal";
import clsx from "clsx";

type QueueStatus = "queued" | "processing" | "success" | "failed";

type QueuedImage = {
  id: string;
  file: File;
  previewUrl: string;
  resultUrl?: string;
  outputName?: string;
  status: QueueStatus;
  error?: string;
  durationMs?: number;
};

type LogEntry = {
  id: string;
  fileName: string;
  status: "success" | "failed" | "info";
  message: string;
  time: string;
};

type Summary = {
  total: number;
  success: number;
  failed: number;
  durationMs: number;
};

const MAX_FILES = 250;
const CONCURRENCY_LIMIT = 3;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const formatDuration = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
};

const sanitizeFileName = (name: string, fallback: string) => {
  const base = name.replace(/\.[^.]+$/, "").trim() || fallback;
  return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, "-");
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The image could not be processed.";
};

export function BulkBackgroundRemover() {
  const [items, setItems] = useState<QueuedImage[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [activeNames, setActiveNames] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [assetProgress, setAssetProgress] = useState<string | null>(null);
  const [processingTotal, setProcessingTotal] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<QueuedImage[]>([]);

  const queuedCount = items.filter((item) => item.status === "queued").length;
  const processableCount = items.filter(
    (item) => item.status === "queued" || item.status === "failed"
  ).length;
  const successCount = items.filter((item) => item.status === "success").length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const totalSize = useMemo(
    () => items.reduce((total, item) => total + item.file.size, 0),
    [items]
  );
  const progressTotal = isProcessing ? processingTotal : items.length;
  const progressPercent =
    progressTotal > 0 ? Math.round((completedCount / progressTotal) * 100) : 0;
  const resultItems = items.filter((item) => item.status === "success" || item.status === "failed");

  const addLog = useCallback((entry: Omit<LogEntry, "id" | "time">) => {
    setLogs((current) => [
      {
        ...entry,
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        })
      },
      ...current
    ]);
  }, []);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      const validFiles = incoming.filter((file) => ACCEPTED_TYPES.has(file.type));
      const invalidFiles = incoming.filter((file) => !ACCEPTED_TYPES.has(file.type));
      const slots = Math.max(MAX_FILES - items.length, 0);
      const accepted = validFiles.slice(0, slots);
      const overflow = Math.max(validFiles.length - accepted.length, 0);

      if (accepted.length) {
        const nextItems = accepted.map((file) => ({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: "queued" as const
        }));
        setItems((current) => [...current, ...nextItems]);
        setSummary(null);
      }

      invalidFiles.forEach((file) =>
        addLog({
          fileName: file.name || "Unsupported file",
          status: "failed",
          message: "Skipped because only JPG, PNG, JPEG, and WebP images are supported."
        })
      );

      if (overflow > 0) {
        addLog({
          fileName: "Queue limit",
          status: "info",
          message: `${overflow} image${overflow === 1 ? "" : "s"} skipped because the queue is capped at ${MAX_FILES}.`
        });
      }
    },
    [addLog, items.length]
  );

  const removeItem = useCallback((id: string) => {
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        if (target.resultUrl) URL.revokeObjectURL(target.resultUrl);
      }
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems((current) => {
      current.forEach((item) => {
        URL.revokeObjectURL(item.previewUrl);
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
      });
      return [];
    });
    setLogs([]);
    setCompletedCount(0);
    setProcessingTotal(0);
    setActiveNames([]);
    setSummary(null);
    setAssetProgress(null);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      addFiles(event.dataTransfer.files);
    },
    [addFiles]
  );

  const startProcessing = useCallback(async () => {
    const batch = items.filter((item) => item.status === "queued" || item.status === "failed");
    if (!batch.length || isProcessing) return;

    setIsProcessing(true);
    setSummary(null);
    setCompletedCount(0);
    setProcessingTotal(batch.length);
    setActiveNames([]);
    setAssetProgress("Preparing on-device AI model...");
    setLogs([]);
    setItems((current) =>
      current.map((item) =>
        batch.some((batchItem) => batchItem.id === item.id)
          ? {
              ...item,
              status: "queued",
              error: undefined,
              durationMs: undefined,
              outputName: undefined,
              resultUrl: item.resultUrl
            }
          : item
      )
    );

    const startedAt = performance.now();
    const zip = new JSZip();
    let cursor = 0;
    let completed = 0;
    let success = 0;
    let failed = 0;

    try {
      const { removeBackground } = await import("@imgly/background-removal");

      const config: Config = {
        model: "isnet_fp16",
        device: "cpu",
        output: {
          format: "image/png",
          quality: 1
        },
        publicPath:
          process.env.NEXT_PUBLIC_IMGLY_BG_ASSET_PATH ||
          "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/",
        progress: (key, current, total) => {
          if (total > 0) {
            const percent = Math.round((current / total) * 100);
            setAssetProgress(`Loading ${key} (${percent}%)`);
          }
        }
      };

      const worker = async () => {
        while (cursor < batch.length) {
          const item = batch[cursor];
          const taskNumber = cursor + 1;
          cursor += 1;
          const itemStartedAt = performance.now();

          setActiveNames((current) => [...current, item.file.name]);
          setItems((current) =>
            current.map((currentItem) =>
              currentItem.id === item.id ? { ...currentItem, status: "processing" } : currentItem
            )
          );

          try {
            const outputBlob = await removeBackground(item.file, config);
            const resultUrl = URL.createObjectURL(outputBlob);
            const outputName = `${String(taskNumber).padStart(3, "0")}-${sanitizeFileName(
              item.file.name,
              `image-${taskNumber}`
            )}-bgvanish.png`;
            zip.file(outputName, outputBlob);
            success += 1;

            setItems((current) =>
              current.map((currentItem) => {
                if (currentItem.id !== item.id) return currentItem;
                if (currentItem.resultUrl) URL.revokeObjectURL(currentItem.resultUrl);
                return {
                  ...currentItem,
                  status: "success",
                  resultUrl,
                  outputName,
                  durationMs: performance.now() - itemStartedAt
                };
              })
            );
            addLog({
              fileName: item.file.name,
              status: "success",
              message: `Exported ${outputName}.`
            });
          } catch (error) {
            failed += 1;
            const message = getErrorMessage(error);
            setItems((current) =>
              current.map((currentItem) =>
                currentItem.id === item.id
                  ? {
                      ...currentItem,
                      status: "failed",
                      error: message,
                      durationMs: performance.now() - itemStartedAt
                    }
                  : currentItem
              )
            );
            addLog({
              fileName: item.file.name,
              status: "failed",
              message
            });
          } finally {
            completed += 1;
            setCompletedCount(completed);
            setActiveNames((current) => current.filter((name) => name !== item.file.name));
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY_LIMIT, batch.length) }, () => worker())
      );

      if (success > 0) {
        setAssetProgress("Packaging transparent PNGs...");
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipBlob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `bgvanish-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 500);
      }

      const durationMs = performance.now() - startedAt;
      setSummary({
        total: batch.length,
        success,
        failed,
        durationMs
      });
      addLog({
        fileName: "Batch complete",
        status: failed > 0 ? "info" : "success",
        message:
          success > 0
            ? `Created ZIP with ${success} transparent PNG${success === 1 ? "" : "s"}.`
            : "No ZIP was created because every image failed."
      });
    } catch (error) {
      const message = getErrorMessage(error);
      setSummary({
        total: batch.length,
        success,
        failed: batch.length - success,
        durationMs: performance.now() - startedAt
      });
      addLog({
        fileName: "Processor",
        status: "failed",
        message
      });
    } finally {
      setAssetProgress(null);
      setActiveNames([]);
      setIsProcessing(false);
      setProcessingTotal(0);
    }
  }, [addLog, isProcessing, items]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    return () => {
      itemsRef.current.forEach((item) => {
        URL.revokeObjectURL(item.previewUrl);
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
      });
    };
  }, []);

  return (
    <main className="relative min-h-screen px-4 py-5 text-white sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-[20px] border border-white/10 bg-white/[0.035] px-5 py-5 backdrop-blur-2xl sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <div className="mb-2 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-300/30 bg-cyan-300/15 text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.16)]">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200/80">
                  Private by design
                </p>
                <h1 className="text-3xl font-semibold tracking-normal text-white sm:text-4xl">
                  BGVanish
                </h1>
              </div>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-white/66 sm:text-base">
              Bulk background removal for designers. Drop a batch, process on your device,
              download transparent PNGs in one ZIP.
            </p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm text-white/64" aria-label="App facts">
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-2">
              250 images max
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-2">
              No uploads
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-2">
              WASM AI
            </span>
          </nav>
        </header>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
          <div className="flex min-w-0 flex-col gap-6">
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDrop={onDrop}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              className={clsx(
                "glass-panel group flex min-h-[315px] cursor-pointer flex-col items-center justify-center rounded-[20px] border-2 border-dashed p-6 text-center sm:p-10",
                isDragging
                  ? "border-cyan-300/70 bg-cyan-300/[0.08] shadow-[0_0_34px_rgba(34,211,238,0.22)]"
                  : "border-cyan-300/25"
              )}
            >
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
              <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-[20px] border border-cyan-200/20 bg-cyan-300/10 text-cyan-100 shadow-[0_0_36px_rgba(34,211,238,0.16)] transition group-hover:scale-105">
                <UploadCloud className="h-9 w-9" aria-hidden="true" />
              </div>
              <h2 className="max-w-xl text-2xl font-semibold tracking-normal text-white sm:text-3xl">
                Drop images to vanish backgrounds
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-white/62 sm:text-base">
                Select JPG, PNG, JPEG, or WebP files. Processing runs locally in your browser, so
                large batches may take a few minutes.
              </p>
              <div className="mt-7 flex flex-wrap items-center justify-center gap-3 text-xs font-medium text-white/64">
                <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-2">
                  Multi-file upload
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-2">
                  Transparent PNG output
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-2">
                  ZIP download
                </span>
              </div>
            </div>

            <section className="glass-panel rounded-[20px] p-4 sm:p-5">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">Queued files</h2>
                  <p className="text-sm text-white/55">
                    {items.length
                      ? `${items.length}/${MAX_FILES} files · ${formatBytes(totalSize)} selected`
                      : "Add images to start a batch."}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    disabled={isProcessing || items.length >= MAX_FILES}
                    className="glass-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm text-white/86 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <UploadCloud className="h-4 w-4" aria-hidden="true" />
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    disabled={isProcessing || items.length === 0}
                    className="glass-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm text-white/70 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Clear All
                  </button>
                </div>
              </div>

              {items.length === 0 ? (
                <div className="flex min-h-[230px] flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.025] px-5 text-center">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-cyan-100">
                    <ImageIcon className="h-8 w-8" aria-hidden="true" />
                  </div>
                  <p className="text-base font-medium text-white">Your queue is clear.</p>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-white/55">
                    Drag in product shots, profile images, mockup exports, or browse from your
                    device.
                  </p>
                </div>
              ) : (
                <div className="custom-scrollbar grid max-h-[390px] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4">
                  {items.map((item) => (
                    <article
                      key={item.id}
                      className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.05]"
                    >
                      <div className="aspect-square overflow-hidden bg-black/30">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                        />
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${item.file.name}`}
                        onClick={() => removeItem(item.id)}
                        disabled={isProcessing}
                        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/80 backdrop-blur-md transition hover:border-cyan-200/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <div className="p-3">
                        <p className="truncate text-sm font-medium text-white/90" title={item.file.name}>
                          {item.file.name}
                        </p>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-white/48">
                          <span>{formatBytes(item.file.size)}</span>
                          <StatusPill status={item.status} />
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="flex min-w-0 flex-col gap-6">
            <section className="glass-panel rounded-[20px] p-5 sm:p-6">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-cyan-200/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                    On-device
                  </p>
                  <h2 className="text-2xl font-semibold text-white">Batch processor</h2>
                  <p className="mt-2 text-sm leading-6 text-white/58">
                    Runs up to {CONCURRENCY_LIMIT} images at a time to keep the tab responsive while
                    the model works locally.
                  </p>
                </div>
                <div className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-cyan-100 sm:flex">
                  <FileArchive className="h-7 w-7" aria-hidden="true" />
                </div>
              </div>

              <button
                type="button"
                onClick={startProcessing}
                disabled={!processableCount || isProcessing}
                className="flex w-full items-center justify-center gap-3 rounded-full bg-cyan-300 px-5 py-4 text-base font-semibold text-slate-950 shadow-[0_0_34px_rgba(34,211,238,0.22)] transition hover:bg-cyan-200 hover:shadow-[0_0_40px_rgba(34,211,238,0.32)] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40 disabled:shadow-none"
              >
                {isProcessing ? (
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="h-5 w-5 fill-slate-950" aria-hidden="true" />
                )}
                {isProcessing ? "Removing backgrounds..." : "Remove Backgrounds"}
              </button>

              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium text-white/82">
                    {completedCount}/{progressTotal || 0} completed
                  </span>
                  <span className="text-cyan-100">{progressPercent}%</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full border border-white/10 bg-white/[0.06]">
                  <div
                    className="h-full rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.55)] transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p className="mt-3 min-h-10 text-sm leading-5 text-white/56">
                  {activeNames.length
                    ? `Processing ${activeNames.join(", ")}`
                    : assetProgress || "Ready for the next batch."}
                </p>
              </div>

              <div className="mt-6 grid grid-cols-3 gap-2">
                <Metric label="Queued" value={queuedCount} />
                <Metric label="Done" value={successCount} />
                <Metric label="Failed" value={failedCount} />
              </div>
            </section>

            {summary && (
              <section className="glass-panel rounded-[20px] p-5 sm:p-6">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-cyan-200/25 bg-cyan-300/10 text-cyan-100">
                    <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold text-white">Batch summary</h2>
                    <p className="text-sm text-white/55">ZIP download starts automatically.</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Total" value={summary.total} />
                  <Metric label="Success" value={summary.success} />
                  <Metric label="Failed" value={summary.failed} />
                  <Metric label="Time" value={formatDuration(summary.durationMs)} />
                </div>
              </section>
            )}

            <section className="glass-panel rounded-[20px] p-5 sm:p-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white">Live previews</h2>
                  <p className="text-sm text-white/55">Before and transparent after views appear as files finish.</p>
                </div>
                <Download className="h-5 w-5 text-cyan-100/80" aria-hidden="true" />
              </div>
              {resultItems.length === 0 ? (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm leading-6 text-white/56">
                  Finished images will show here with a checkerboard behind the transparent PNG.
                </div>
              ) : (
                <div className="custom-scrollbar max-h-[520px] space-y-3 overflow-y-auto pr-1">
                  {resultItems.map((item) => (
                    <article key={item.id} className="rounded-2xl border border-white/10 bg-white/[0.045] p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white/88" title={item.file.name}>
                            {item.file.name}
                          </p>
                          <p className="text-xs text-white/45">
                            {item.durationMs ? formatDuration(item.durationMs) : "Waiting"}
                          </p>
                        </div>
                        <StatusPill status={item.status} />
                      </div>
                      {item.status === "failed" ? (
                        <div className="flex items-start gap-2 rounded-xl border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100/86">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>{item.error || "Could not process this image."}</span>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <PreviewTile label="Before" src={item.previewUrl} alt={`${item.file.name} before`} />
                          <PreviewTile
                            label="After"
                            src={item.resultUrl}
                            alt={`${item.file.name} after`}
                            checkerboard
                          />
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>

            <details className="glass-panel group rounded-[20px] p-5 sm:p-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-white">Processing log</h2>
                  <p className="text-sm text-white/55">{logs.length} events recorded</p>
                </div>
                <ChevronDown className="h-5 w-5 text-white/50 transition group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="custom-scrollbar mt-5 max-h-80 space-y-2 overflow-y-auto pr-1">
                {logs.length === 0 ? (
                  <p className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/55">
                    Skips, corrupt files, and completed exports will be listed here.
                  </p>
                ) : (
                  logs.map((log) => (
                    <div
                      key={log.id}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm"
                    >
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="truncate font-medium text-white/86" title={log.fileName}>
                          {log.fileName}
                        </span>
                        <span className="shrink-0 text-xs text-white/42">{log.time}</span>
                      </div>
                      <p
                        className={clsx(
                          "leading-5",
                          log.status === "success" && "text-cyan-100/78",
                          log.status === "failed" && "text-red-100/78",
                          log.status === "info" && "text-white/58"
                        )}
                      >
                        {log.message}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </details>
          </aside>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-3">
      <p className="text-xs uppercase tracking-[0.16em] text-white/42">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: QueueStatus }) {
  const styles = {
    queued: "border-white/10 bg-white/[0.06] text-white/54",
    processing: "border-cyan-200/30 bg-cyan-300/10 text-cyan-100",
    success: "border-emerald-200/25 bg-emerald-400/10 text-emerald-100",
    failed: "border-red-200/25 bg-red-400/10 text-red-100"
  };

  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium capitalize",
        styles[status]
      )}
    >
      {status === "processing" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
      {status === "success" && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
      {status === "failed" && <AlertCircle className="h-3 w-3" aria-hidden="true" />}
      {status}
    </span>
  );
}

function PreviewTile({
  label,
  src,
  alt,
  checkerboard = false
}: {
  label: string;
  src?: string;
  alt: string;
  checkerboard?: boolean;
}) {
  return (
    <div className={clsx("relative aspect-square overflow-hidden rounded-xl border border-white/10", checkerboard && "checkerboard")}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full items-center justify-center text-white/36">
          <TimerReset className="h-6 w-6" aria-hidden="true" />
        </div>
      )}
      <span className="absolute left-2 top-2 rounded-full border border-white/10 bg-black/45 px-2 py-1 text-[11px] font-medium text-white/78 backdrop-blur-md">
        {label}
      </span>
    </div>
  );
}
