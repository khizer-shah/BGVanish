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
const CONCURRENCY_LIMIT = 1;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PROGRESS_UPDATE_INTERVAL_MS = 300;

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

const yieldToBrowser = () =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });

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
  const progressUpdateRef = useRef(0);
  const successfulItems = items.filter((item) => item.status === "success" && item.resultUrl);

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

  const downloadSingle = useCallback((item: QueuedImage) => {
    if (!item.resultUrl) return;
    const anchor = document.createElement("a");
    anchor.href = item.resultUrl;
    anchor.download =
      item.outputName || `${sanitizeFileName(item.file.name, "bgvanish-image")}-bgvanish.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const downloadAll = useCallback(async () => {
    const successful = itemsRef.current.filter((item) => item.status === "success" && item.resultUrl);
    if (!successful.length) return;

    const zip = new JSZip();
    await Promise.all(
      successful.map(async (item, index) => {
        if (!item.resultUrl) return;
        const response = await fetch(item.resultUrl);
        const blob = await response.blob();
        const outputName =
          item.outputName ||
          `${String(index + 1).padStart(3, "0")}-${sanitizeFileName(
            item.file.name,
            `image-${index + 1}`
          )}-bgvanish.png`;
        zip.file(outputName, blob);
      })
    );

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(zipBlob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `bgvanish-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
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
    progressUpdateRef.current = 0;
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
        rescale: true,
        output: {
          format: "image/png",
          quality: 1
        },
        publicPath:
          process.env.NEXT_PUBLIC_IMGLY_BG_ASSET_PATH ||
          "https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/",
        progress: (key, current, total) => {
          if (total > 0) {
            const now = performance.now();
            const percent = Math.round((current / total) * 100);
            if (now - progressUpdateRef.current > PROGRESS_UPDATE_INTERVAL_MS || percent >= 100) {
              progressUpdateRef.current = now;
              setAssetProgress(`${key.replace("compute:", "").replace("fetch:", "Loading ")} (${percent}%)`);
            }
          }
        }
      };

      const worker = async () => {
        while (cursor < batch.length) {
          await yieldToBrowser();
          const item = batch[cursor];
          const taskNumber = cursor + 1;
          cursor += 1;
          const itemStartedAt = performance.now();

          setActiveNames([item.file.name]);
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
            setActiveNames([]);
            await yieldToBrowser();
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
    <main className="relative min-h-screen overflow-hidden px-4 py-5 text-slate-950 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute left-[-7rem] top-20 h-72 w-72 rounded-full bg-blue-200/50 blur-3xl" />
      <div className="pointer-events-none absolute right-[-8rem] top-4 h-96 w-96 rounded-full bg-indigo-200/50 blur-3xl" />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex items-center justify-between py-2">
          <div className="text-2xl font-extrabold tracking-normal text-slate-950">BGVanish</div>
          <nav className="hidden items-center gap-2 text-sm font-medium text-slate-600 sm:flex">
            <span className="rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-slate-200">
              250 images max
            </span>
            <span className="rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-slate-200">
              Private on-device
            </span>
          </nav>
        </header>

        <section className="grid items-center gap-8 lg:grid-cols-[1fr_420px]">
          <div className="mx-auto max-w-3xl text-center lg:mx-0 lg:text-left">
            <p className="mb-4 inline-flex rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 ring-1 ring-blue-100">
              Bulk background remover for designers
            </p>
            <h1 className="text-4xl font-extrabold leading-tight tracking-normal text-slate-950 sm:text-5xl lg:text-6xl">
              Remove image backgrounds in your browser
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg lg:mx-0">
              Upload JPG, PNG, JPEG, or WebP files and export transparent PNGs. Nothing is sent to
              a server, so large batches may take a few minutes on your device.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm text-slate-500 lg:justify-start">
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-slate-200">
                <CheckCircle2 className="h-4 w-4 text-blue-600" aria-hidden="true" />
                Transparent PNGs
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-slate-200">
                <FileArchive className="h-4 w-4 text-blue-600" aria-hidden="true" />
                ZIP or single downloads
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-slate-200">
                <Lock className="h-4 w-4 text-blue-600" aria-hidden="true" />
                No uploads
              </span>
            </div>
          </div>

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
              "upload-card group flex min-h-[360px] cursor-pointer flex-col items-center justify-center rounded-[32px] border-2 border-dashed bg-white p-7 text-center shadow-[0_18px_60px_rgba(15,23,42,0.12)] transition sm:p-9",
              isDragging
                ? "border-blue-500 bg-blue-50 shadow-[0_24px_70px_rgba(37,99,235,0.22)]"
                : "border-blue-200 hover:border-blue-400 hover:shadow-[0_24px_70px_rgba(37,99,235,0.16)]"
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
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-blue-50 text-blue-600 ring-1 ring-blue-100 transition group-hover:scale-105">
              <UploadCloud className="h-10 w-10" aria-hidden="true" />
            </div>
            <h2 className="text-2xl font-extrabold tracking-normal text-slate-950">
              Upload images
            </h2>
            <p className="mt-3 max-w-sm text-sm leading-6 text-slate-500">
              Drag and drop a batch here or click to browse. Up to {MAX_FILES} images.
            </p>
            <button
              type="button"
              className="mt-7 rounded-full bg-blue-600 px-8 py-4 text-base font-bold text-white shadow-[0_14px_34px_rgba(37,99,235,0.28)] transition hover:bg-blue-700"
            >
              Upload Image
            </button>
            <p className="mt-4 text-xs text-slate-400">Supports JPG, PNG, JPEG, WebP</p>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-6">
            <section className="soft-card rounded-[28px] p-4 sm:p-5">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-950">Queued files</h2>
                  <p className="text-sm text-slate-500">
                    {items.length
                      ? `${items.length}/${MAX_FILES} files - ${formatBytes(totalSize)} selected`
                      : "Add images to start a batch."}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    disabled={isProcessing || items.length >= MAX_FILES}
                    className="secondary-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <UploadCloud className="h-4 w-4" aria-hidden="true" />
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    disabled={isProcessing || items.length === 0}
                    className="secondary-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    Clear All
                  </button>
                </div>
              </div>

              {items.length === 0 ? (
                <div className="flex min-h-[220px] flex-col items-center justify-center rounded-[24px] bg-slate-50 px-5 text-center ring-1 ring-slate-100">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white text-blue-600 shadow-sm ring-1 ring-slate-200">
                    <ImageIcon className="h-8 w-8" aria-hidden="true" />
                  </div>
                  <p className="text-base font-bold text-slate-950">No images yet</p>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
                    Upload product shots, portraits, mockups, or exports from your design tool.
                  </p>
                </div>
              ) : (
                <div className="custom-scrollbar grid max-h-[430px] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 xl:grid-cols-4">
                  {items.map((item) => (
                    <article
                      key={item.id}
                      className="group relative overflow-hidden rounded-[22px] bg-white shadow-sm ring-1 ring-slate-200"
                    >
                      <div className="aspect-square overflow-hidden bg-slate-100">
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
                        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/95 text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <div className="p-3">
                        <p className="truncate text-sm font-semibold text-slate-800" title={item.file.name}>
                          {item.file.name}
                        </p>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-400">
                          <span>{formatBytes(item.file.size)}</span>
                          <StatusPill status={item.status} />
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="soft-card rounded-[28px] p-4 sm:p-5">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-950">Removed backgrounds</h2>
                  <p className="text-sm text-slate-500">
                    Download each transparent PNG or use the automatic ZIP after processing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={downloadAll}
                  disabled={!successfulItems.length}
                  className="secondary-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <FileArchive className="h-4 w-4" aria-hidden="true" />
                  Download All
                </button>
              </div>
              {resultItems.length === 0 ? (
                <div className="rounded-[24px] bg-slate-50 p-6 text-sm leading-6 text-slate-500 ring-1 ring-slate-100">
                  Results will appear here with a checkerboard behind transparent output.
                </div>
              ) : (
                <div className="custom-scrollbar max-h-[620px] space-y-4 overflow-y-auto pr-1">
                  {resultItems.map((item) => (
                    <article key={item.id} className="rounded-[24px] bg-white p-3 shadow-sm ring-1 ring-slate-200">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-800" title={item.file.name}>
                            {item.file.name}
                          </p>
                          <p className="text-xs text-slate-400">
                            {item.durationMs ? formatDuration(item.durationMs) : "Waiting"}
                          </p>
                        </div>
                        <StatusPill status={item.status} />
                      </div>
                      {item.status === "failed" ? (
                        <div className="flex items-start gap-2 rounded-2xl bg-red-50 p-3 text-sm text-red-700 ring-1 ring-red-100">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>{item.error || "Could not process this image."}</span>
                        </div>
                      ) : (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            <PreviewTile label="Original" src={item.previewUrl} alt={`${item.file.name} before`} />
                            <PreviewTile
                              label="Removed"
                              src={item.resultUrl}
                              alt={`${item.file.name} after`}
                              checkerboard
                              onDownload={() => downloadSingle(item)}
                            />
                          </div>
                        </>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="flex min-w-0 flex-col gap-6">
            <section className="soft-card rounded-[28px] p-5 sm:p-6">
              <div className="mb-5">
                <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.14em] text-blue-700 ring-1 ring-blue-100">
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  On-device
                </p>
                <h2 className="text-2xl font-extrabold text-slate-950">Process batch</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Processes one high-quality image at a time to keep the browser responsive.
                </p>
              </div>

              <button
                type="button"
                onClick={startProcessing}
                disabled={!processableCount || isProcessing}
                className="flex w-full items-center justify-center gap-3 rounded-full bg-blue-600 px-5 py-4 text-base font-bold text-white shadow-[0_14px_34px_rgba(37,99,235,0.28)] transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
              >
                {isProcessing ? (
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="h-5 w-5 fill-white" aria-hidden="true" />
                )}
                {isProcessing ? "Removing backgrounds..." : "Remove Backgrounds"}
              </button>

              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-semibold text-slate-700">
                    {completedCount}/{progressTotal || 0} completed
                  </span>
                  <span className="font-bold text-blue-700">{progressPercent}%</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p className="mt-3 min-h-10 text-sm leading-5 text-slate-500">
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
              <section className="soft-card rounded-[28px] p-5 sm:p-6">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-green-50 text-green-600 ring-1 ring-green-100">
                    <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <div>
                    <h2 className="text-xl font-extrabold text-slate-950">Batch summary</h2>
                    <p className="text-sm text-slate-500">ZIP download starts automatically.</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Metric label="Total" value={summary.total} />
                  <Metric label="Success" value={summary.success} />
                  <Metric label="Failed" value={summary.failed} />
                  <Metric label="Time" value={formatDuration(summary.durationMs)} />
                </div>
              </section>
            )}

            <details className="soft-card group rounded-[28px] p-5 sm:p-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-extrabold text-slate-950">Processing log</h2>
                  <p className="text-sm text-slate-500">{logs.length} events recorded</p>
                </div>
                <ChevronDown className="h-5 w-5 text-slate-400 transition group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="custom-scrollbar mt-5 max-h-80 space-y-2 overflow-y-auto pr-1">
                {logs.length === 0 ? (
                  <p className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500 ring-1 ring-slate-100">
                    Skips, corrupt files, and completed exports will be listed here.
                  </p>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="rounded-2xl bg-slate-50 p-3 text-sm ring-1 ring-slate-100">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <span className="truncate font-semibold text-slate-800" title={log.fileName}>
                          {log.fileName}
                        </span>
                        <span className="shrink-0 text-xs text-slate-400">{log.time}</span>
                      </div>
                      <p
                        className={clsx(
                          "leading-5",
                          log.status === "success" && "text-green-700",
                          log.status === "failed" && "text-red-700",
                          log.status === "info" && "text-slate-500"
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
    <div className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="mt-1 truncate text-lg font-extrabold text-slate-950">{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: QueueStatus }) {
  const styles = {
    queued: "bg-slate-100 text-slate-500 ring-slate-200",
    processing: "bg-blue-50 text-blue-700 ring-blue-100",
    success: "bg-green-50 text-green-700 ring-green-100",
    failed: "bg-red-50 text-red-700 ring-red-100"
  };

  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold capitalize ring-1",
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
  checkerboard = false,
  onDownload
}: {
  label: string;
  src?: string;
  alt: string;
  checkerboard?: boolean;
  onDownload?: () => void;
}) {
  return (
    <div
      className={clsx(
        "relative aspect-square overflow-hidden rounded-2xl bg-slate-100 ring-1 ring-slate-200",
        checkerboard && "checkerboard"
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="h-full w-full object-contain" />
      ) : (
        <div className="flex h-full items-center justify-center text-slate-300">
          <TimerReset className="h-6 w-6" aria-hidden="true" />
        </div>
      )}
      <span className="absolute left-2 top-2 rounded-full bg-white/95 px-2 py-1 text-[11px] font-bold text-slate-600 shadow-sm ring-1 ring-slate-200">
        {label}
      </span>
      {onDownload && src && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDownload();
          }}
          aria-label={`Download ${alt}`}
          className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/20 ring-1 ring-blue-500 transition hover:bg-blue-700"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
