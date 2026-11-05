import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { describe, expect, it, vi } from "vitest";
import { createBridgeTelemetry, POSTHOG_SERVICE_NAME } from "../src/posthog.js";

const analytics = () => ({
  flush: async () => undefined,
  shutdown: async () => undefined,
});

describe("log flush batching", () => {
  it("scrubs every record before exporting multiple records in one batch", async () => {
    const batches: ReadableLogRecord[][] = [];
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: analytics,
        createLogExporter: () => ({
          export(batch, callback) {
            batches.push([...batch]);
            callback({ code: ExportResultCode.SUCCESS });
          },
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    try {
      for (const durationMs of [1, 2, 3]) {
        logs.getLogger(POSTHOG_SERVICE_NAME).emit({
          body: "webhook_handled",
          attributes: {
            kind: "forwarded",
            reason: "forwarded",
            duration_ms: durationMs,
            upstream_status: 200,
            outbound_duration_ms: 0.5,
            body: '{"tenant":"AdaTenant991"}',
            authorization: "Bearer crsr_private",
            signature: "private-signature",
            upstreamUrl: "https://private.example/hook",
          },
        });
      }
      await telemetry.flush();

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expect(batches[0]?.map((record) => record.attributes)).toEqual(
        [1, 2, 3].map((durationMs) => ({
          kind: "forwarded",
          reason: "forwarded",
          duration_ms: durationMs,
          upstream_status: 200,
          outbound_duration_ms: 0.5,
        })),
      );
      expect(
        batches[0]?.every((record) => record.body === "webhook_handled"),
      ).toBe(true);
      const serialized = JSON.stringify(batches);
      for (const secret of [
        "AdaTenant991",
        "crsr_private",
        "private-signature",
        "private.example",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await telemetry.shutdown();
    }
  });

  it("exports records emitted during an earlier flush before the later flush settles", async () => {
    const batches: ReadableLogRecord[][] = [];
    const callbacks: Array<Parameters<LogRecordExporter["export"]>[1]> = [];
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: analytics,
        createLogExporter: () => ({
          export(batch, callback) {
            batches.push([...batch]);
            callbacks.push(callback);
          },
          forceFlush: async () => undefined,
          shutdown: async () => undefined,
        }),
      },
    );
    let firstSettled = false;
    let secondSettled = false;
    try {
      telemetry.captureWebhookHandled({
        kind: "forwarded",
        reason: "forwarded",
        durationMs: 1,
        upstreamStatus: 200,
        outboundDurationMs: 0.5,
      });
      const first = telemetry.flush().then(() => {
        firstSettled = true;
      });
      await vi.waitFor(() => expect(batches).toHaveLength(1));

      telemetry.captureWebhookHandled({
        kind: "forwarded",
        reason: "forwarded",
        durationMs: 2,
        upstreamStatus: 204,
        outboundDurationMs: 0.5,
      });
      const second = telemetry.flush().then(() => {
        secondSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(batches).toHaveLength(1);

      callbacks[0]?.({ code: ExportResultCode.SUCCESS });
      await first;
      await vi.waitFor(() => expect(batches).toHaveLength(2));
      expect(secondSettled).toBe(false);
      expect(
        batches.map((batch) =>
          batch.map((record) => record.attributes.duration_ms),
        ),
      ).toEqual([[1], [2]]);

      callbacks[1]?.({ code: ExportResultCode.SUCCESS });
      await second;
      expect(secondSettled).toBe(true);
    } finally {
      for (const callback of callbacks) {
        callback({ code: ExportResultCode.SUCCESS });
      }
      await telemetry.shutdown();
    }
  });

  it("runs a queued log flush after an earlier flush rejects", async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const firstExport = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const forceFlush = vi
      .fn()
      .mockReturnValueOnce(firstExport)
      .mockResolvedValueOnce(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const telemetry = createBridgeTelemetry(
      { POSTHOG_PROJECT_KEY: "phc_test" },
      {
        createAnalyticsClient: analytics,
        startLogs: () => ({ forceFlush, shutdown: async () => undefined }),
      },
    );
    try {
      const first = telemetry.flush();
      const second = telemetry.flush();
      await vi.waitFor(() => expect(forceFlush).toHaveBeenCalledTimes(1));
      rejectFirst(new Error("export failed"));
      await Promise.all([first, second]);
      expect(forceFlush).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "telemetry_flush_failed logs rejected",
      );
    } finally {
      rejectFirst(new Error("export failed"));
      log.mockRestore();
      await telemetry.shutdown();
    }
  });
});
