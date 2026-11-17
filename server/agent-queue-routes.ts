import type {
  QueueCreateTaskRequest,
  QueueReorderRequest,
  QueueUpdateSettingsRequest,
  QueueUpdateTaskRequest,
} from "../shared/agent-queue.ts";
import type { AgentQueueService } from "./agent-queue.ts";
import {
  QueueConflictError,
  QueueNotFoundError,
  QueueValidationError,
} from "./agent-queue-store.ts";
import type { ServerContext } from "./dispatch.ts";
import {
  badRequest,
  conflictResponse,
  errorResponse,
  jsonResponse,
  readJsonObject,
  setRequestRoute,
} from "./http.ts";

function unsupported(): Response {
  return jsonResponse({ error: { code: "unsupported", message: "Agent queue requires the herdr-core runtime" } }, 501);
}

function methodNotAllowed(message: string, allow: string): Response {
  return jsonResponse({ error: { code: "method_not_allowed", message } }, 405, { allow });
}

function mapQueueError(error: unknown): Response {
  if (error instanceof QueueValidationError) {
    return badRequest(error.code, error.message);
  }
  if (error instanceof QueueNotFoundError) {
    return jsonResponse({ error: { code: error.code, message: error.message } }, 404);
  }
  if (error instanceof QueueConflictError) {
    return conflictResponse(error.code, error.message);
  }
  return errorResponse(error);
}

function decodeTaskId(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded === "" ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Handles `/api/queue*` endpoints for inspecting and mutating the local per-project agent task queue.
 * Auth, same-origin, canonical-path, and `watch` (`readOnly`) checks run first in `server/dispatch.ts`.
 */
export async function handleAgentQueueRequest(
  request: Request,
  pathname: string,
  ctx: ServerContext,
  agentQueue: AgentQueueService | null,
): Promise<Response | undefined> {
  if (pathname !== "/api/queue" && !pathname.startsWith("/api/queue/")) {
    return undefined;
  }

  if (pathname === "/api/queue") {
    setRequestRoute("/api/queue");
    if (!agentQueue) return unsupported();
    if (request.method !== "GET") return methodNotAllowed("Use GET /api/queue", "GET");
    try {
      return jsonResponse(await agentQueue.snapshot(), 200, { "cache-control": "no-store" });
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/queue/tasks") {
    setRequestRoute("/api/queue/tasks");
    if (!agentQueue) return unsupported();
    if (request.method !== "POST") return methodNotAllowed("Use POST /api/queue/tasks", "POST");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (body["hold"] !== undefined && typeof body["hold"] !== "boolean") {
      return badRequest("invalid_hold", "hold must be true or false");
    }
    const input: QueueCreateTaskRequest = {
      folder: body["folder"] as string,
      prompt: body["prompt"] as string,
      ...(body["title"] !== undefined ? { title: body["title"] as string } : {}),
      ...(body["agent"] !== undefined ? { agent: body["agent"] as string } : {}),
      ...(body["hold"] !== undefined ? { hold: body["hold"] as boolean } : {}),
    };
    try {
      return jsonResponse(agentQueue.createTask(input), 201, { "cache-control": "no-store" });
    } catch (error) {
      return mapQueueError(error);
    }
  }

  if (pathname === "/api/queue/reorder") {
    setRequestRoute("/api/queue/reorder");
    if (!agentQueue) return unsupported();
    if (request.method !== "POST") return methodNotAllowed("Use POST /api/queue/reorder", "POST");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    let input: QueueReorderRequest;
    if ("id" in body) {
      if (typeof body["id"] !== "string" || body["id"].trim() === "") {
        return badRequest("invalid_reorder", "id must be a non-empty string");
      }
      input = { id: body["id"], direction: body["direction"] as "up" | "down" };
    } else {
      if (
        typeof body["folder"] !== "string" ||
        !Array.isArray(body["orderedIds"]) ||
        !body["orderedIds"].every((id) => typeof id === "string")
      ) {
        return badRequest("invalid_reorder", "folder and orderedIds are required");
      }
      input = { folder: body["folder"], orderedIds: body["orderedIds"] };
    }
    try {
      return jsonResponse(agentQueue.reorder(input), 200, { "cache-control": "no-store" });
    } catch (error) {
      return mapQueueError(error);
    }
  }

  if (pathname === "/api/queue/settings") {
    setRequestRoute("/api/queue/settings");
    if (!agentQueue) return unsupported();
    if (request.method !== "PATCH") return methodNotAllowed("Use PATCH /api/queue/settings", "PATCH");
    const body = await readJsonObject<QueueUpdateSettingsRequest>(request);
    if (body instanceof Response) return body;
    try {
      return jsonResponse(agentQueue.updateSettings(body), 200, { "cache-control": "no-store" });
    } catch (error) {
      return mapQueueError(error);
    }
  }

  if (pathname.startsWith("/api/queue/tasks/")) {
    const rest = pathname.slice("/api/queue/tasks/".length);
    const parts = rest.split("/");
    if (parts.length === 2 && parts[1] === "start") {
      setRequestRoute("/api/queue/tasks/:id/start");
      if (!agentQueue) return unsupported();
      if (request.method !== "POST") return methodNotAllowed("Use POST /api/queue/tasks/:id/start", "POST");
      const id = decodeTaskId(parts[0]!);
      if (!id) return badRequest("invalid_task_id", "Invalid task ID");
      // Starting immediately creates a tab, launches the agent CLI, and may wait for initial prompt delivery.
      ctx.timeout(request, 75);
      try {
        return jsonResponse(await agentQueue.startNow(id), 200, { "cache-control": "no-store" });
      } catch (error) {
        return mapQueueError(error);
      }
    }

    if (parts.length === 1) {
      setRequestRoute("/api/queue/tasks/:id");
      if (!agentQueue) return unsupported();
      const id = decodeTaskId(parts[0]!);
      if (!id) return badRequest("invalid_task_id", "Invalid task ID");

      if (request.method === "PATCH") {
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        if (body["hold"] !== undefined && typeof body["hold"] !== "boolean") {
          return badRequest("invalid_hold", "hold must be true or false");
        }
        if (body["status"] !== undefined && body["status"] !== "queued") {
          return badRequest("invalid_status", "status may only be set to queued");
        }
        const patch: QueueUpdateTaskRequest = {
          ...(body["folder"] !== undefined ? { folder: body["folder"] as string } : {}),
          ...(body["title"] !== undefined ? { title: body["title"] as string } : {}),
          ...(body["prompt"] !== undefined ? { prompt: body["prompt"] as string } : {}),
          ...(body["agent"] !== undefined ? { agent: body["agent"] as string } : {}),
          ...(body["hold"] !== undefined ? { hold: body["hold"] as boolean } : {}),
          ...(body["status"] === "queued" ? { status: "queued" } : {}),
        };
        try {
          return jsonResponse(agentQueue.updateTask(id, patch), 200, { "cache-control": "no-store" });
        } catch (error) {
          return mapQueueError(error);
        }
      }

      if (request.method === "DELETE") {
        try {
          return jsonResponse(agentQueue.deleteTask(id), 200, { "cache-control": "no-store" });
        } catch (error) {
          return mapQueueError(error);
        }
      }

      return methodNotAllowed("Use PATCH or DELETE /api/queue/tasks/:id", "PATCH, DELETE");
    }
  }

  return undefined;
}
