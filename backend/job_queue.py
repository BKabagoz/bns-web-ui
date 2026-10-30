"""Small FIFO worker queue for expensive local GWINC calculations."""
from __future__ import annotations

import os
import queue
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any

from .engine import compute_sweep


@dataclass
class SweepJob:
    id: str
    request: Any
    status: str = "queued"
    submitted_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    completed_points: int = 0
    total_points: int = 0
    message: str = "Waiting for a calculation worker…"
    error: str | None = None
    result: dict[str, Any] | None = None
    cancelled: threading.Event = field(default_factory=threading.Event, repr=False)


class JobQueue:
    """FIFO job manager.  Each worker runs one independent GWINC sweep."""

    def __init__(self, concurrency: int | None = None):
        configured = concurrency if concurrency is not None else os.getenv("BNS_WORKER_CONCURRENCY", "1")
        self.concurrency = max(1, min(int(configured), 2))
        self._jobs: dict[str, SweepJob] = {}
        self._pending: queue.Queue[str] = queue.Queue()
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._workers = [threading.Thread(target=self._worker, name=f"bns-worker-{index + 1}", daemon=True)
                         for index in range(self.concurrency)]
        for worker in self._workers:
            worker.start()

    def submit(self, request: Any) -> SweepJob:
        job = SweepJob(id=uuid.uuid4().hex, request=request)
        with self._lock:
            self._jobs[job.id] = job
            self._pending.put(job.id)
        return job

    def get(self, job_id: str) -> SweepJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> SweepJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.cancelled.set()
            if job.status == "queued":
                job.status = "cancelled"
                job.finished_at = time.time()
                job.message = "Cancelled before calculation began."
            elif job.status == "running":
                job.message = "Cancellation requested; the current GWINC call will finish first."
            return job

    def queue_position(self, job_id: str) -> int | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None or job.status != "queued":
                return None
            queued = [item for item in self._jobs.values() if item.status == "queued" and not item.cancelled.is_set()]
            queued.sort(key=lambda item: item.submitted_at)
            return next((index + 1 for index, item in enumerate(queued) if item.id == job_id), None)

    def snapshot(self, job: SweepJob) -> dict[str, Any]:
        with self._lock:
            return {
                "id": job.id, "status": job.status, "message": job.message,
                "completed_points": job.completed_points, "total_points": job.total_points,
                "queue_position": self.queue_position(job.id), "submitted_at": job.submitted_at,
                "started_at": job.started_at, "finished_at": job.finished_at,
                "error": job.error,
            }

    def _progress(self, job: SweepJob, completed: int, total: int, message: str) -> None:
        with self._lock:
            job.completed_points, job.total_points, job.message = completed, total, message

    def _worker(self) -> None:
        while not self._stop.is_set():
            try:
                job_id = self._pending.get(timeout=0.25)
            except queue.Empty:
                continue
            with self._lock:
                job = self._jobs.get(job_id)
                if job is None or job.cancelled.is_set():
                    self._pending.task_done()
                    continue
                job.status, job.started_at = "running", time.time()
                job.message = "Preparing the GWINC calculation…"
            try:
                result = compute_sweep(
                    job.request,
                    is_cancelled=job.cancelled.is_set,
                    progress=lambda completed, total, message: self._progress(job, completed, total, message),
                )
                with self._lock:
                    job.result = result if not result.get("cancelled") else None
                    job.completed_points = int(result.get("completed_points", job.completed_points))
                    job.total_points = int(result.get("total_points", job.total_points))
                    job.status = "cancelled" if result.get("cancelled") else "completed"
                    job.message = ("Cancelled between GWINC calls." if result.get("cancelled")
                                   else "Calculation complete.")
                    job.finished_at = time.time()
            except Exception as exc:
                with self._lock:
                    job.status = "failed"
                    job.error = f"{type(exc).__name__}: {exc}"
                    job.message = "The calculation failed."
                    job.finished_at = time.time()
                    job.result = {"traceback": traceback.format_exc()}
            finally:
                self._pending.task_done()

    def shutdown(self) -> None:
        self._stop.set()
