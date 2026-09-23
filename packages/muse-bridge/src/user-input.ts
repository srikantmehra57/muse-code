import type { Connection, NotificationHandler } from "@muse-code/sdk";
import type { UserInputRequest } from "./protocol.js";

// MuseClient owns the connection's single notification callback. This adapter
// preserves that callback and binds SDK methods to their original private state.
export function observeNotifications(connection: Connection, observe: NotificationHandler): Connection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === "onNotification") {
        return (handler: NotificationHandler) => target.onNotification((notification) => {
          handler(notification);
          observe(notification);
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class UserInputRelay {
  private pending = new Map<string, Map<string, UserInputRequest>>();
  private settled = new Set<string>();
  private versions = new Map<string, number>();
  constructor(private emit: (sessionId: string, requests: UserInputRequest[]) => void) {}

  requests(sessionId: string): UserInputRequest[] {
    return [...(this.pending.get(sessionId)?.values() ?? [])];
  }

  version(sessionId: string) { return this.versions.get(sessionId) ?? 0; }

  restore(sessionId: string, requests: UserInputRequest[], version: number) {
    // A point-in-time read must not erase newer notifications delivered in flight.
    if (this.version(sessionId) === version) this.pending.delete(sessionId);
    for (const request of requests) {
      this.notify({ jsonrpc: "2.0", method: "userInput/requested", params: { ...request } });
    }
    this.emit(sessionId, this.requests(sessionId));
  }

  notify: NotificationHandler = (notification) => {
    const params = notification.params;
    if (typeof params?.sessionId !== "string") return;
    if (notification.method === "turn/completed") {
      for (const request of this.requests(params.sessionId)) {
        if (request.turnId === params.turnId) this.notify({ jsonrpc: "2.0", method: "userInput/settled", params: { sessionId: params.sessionId, userInputId: request.userInputId } });
      }
      return;
    }
    if (typeof params.userInputId !== "string") return;
    const { sessionId, userInputId } = params;
    const key = JSON.stringify([sessionId, userInputId]);
    if (notification.method === "userInput/requested") {
      if (this.settled.has(key) || !Array.isArray(params.questions)) return;
      const requests = this.pending.get(sessionId) ?? new Map();
      requests.set(userInputId, params as unknown as UserInputRequest);
      this.pending.set(sessionId, requests);
    } else if (notification.method === "userInput/settled") {
      this.settled.add(key);
      this.pending.get(sessionId)?.delete(userInputId);
    } else return;
    this.versions.set(sessionId, this.version(sessionId) + 1);
    this.emit(sessionId, this.requests(sessionId));
  };
}
