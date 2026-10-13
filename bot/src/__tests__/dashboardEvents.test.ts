import { describe, expect, it, vi } from "vitest";
import { DashboardEventBus } from "../dashboardEvents";

describe("DashboardEventBus", () => {
  it("sends scoped update events to connected dashboards", () => {
    const events = new DashboardEventBus();
    const client = { write: vi.fn() };
    events.subscribe(client);

    events.publish(["queue", "recent"]);

    expect(client.write).toHaveBeenCalledWith(
      'event: dashboard-update\ndata: {"scopes":["queue","recent"]}\n\n',
    );
  });

  it("stops writing after a dashboard disconnects", () => {
    const events = new DashboardEventBus();
    const client = { write: vi.fn() };
    const unsubscribe = events.subscribe(client);
    unsubscribe();

    events.publish(["queue"]);

    expect(client.write).not.toHaveBeenCalled();
  });

  it("drops clients whose response has already closed", () => {
    const events = new DashboardEventBus();
    const disconnected = { write: vi.fn(() => { throw new Error("closed"); }) };
    const connected = { write: vi.fn() };
    events.subscribe(disconnected);
    events.subscribe(connected);

    events.publish(["stats"]);
    events.publish(["charts"]);

    expect(disconnected.write).toHaveBeenCalledTimes(1);
    expect(connected.write).toHaveBeenCalledTimes(2);
  });
});
