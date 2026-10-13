export type DashboardUpdateScope = "queue" | "stats" | "charts" | "recent";

export interface DashboardSseClient {
  write(data: string): unknown;
  end?(): unknown;
}

export class DashboardEventBus {
  private readonly clients = new Set<DashboardSseClient>();

  subscribe(client: DashboardSseClient): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  publish(scopes: DashboardUpdateScope[]): void {
    const uniqueScopes = [...new Set(scopes)];
    if (uniqueScopes.length === 0) return;

    const frame = `event: dashboard-update\ndata: ${JSON.stringify({ scopes: uniqueScopes })}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  heartbeat(): void {
    for (const client of this.clients) {
      try {
        client.write(": keep-alive\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.end?.();
      } catch {
        // The browser may already have closed this stream.
      }
    }
    this.clients.clear();
  }
}
