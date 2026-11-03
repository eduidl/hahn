import "./setup";
import { render } from "@testing-library/react";
import { useReducer, useState } from "react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { createPlaybackStore, PlaybackContext } from "../../src/workspace/playback";
import { WidgetWorkspace } from "../../src/workspace/WidgetWorkspace";
import { WidgetSettings } from "../../src/workspace/WidgetSettings";
import { buildFieldIndex } from "../../src/workspace/fieldIndex";
import {
  initialWorkspace,
  widgetTypes,
  workspaceReducer as reduce,
  type WorkspaceState,
} from "../../src/workspace/widgets";

const index = buildFieldIndex([]);

function Workspace({ initialState }: { initialState: WorkspaceState }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [playback] = useState(createPlaybackStore);
  const selected = state.activeId ? state.widgets[state.activeId] : null;
  return (
    <PlaybackContext.Provider value={playback}>
      <div className="workspace">
        <aside data-testid="settings">
          {selected && (
            <WidgetSettings widget={selected} dispatch={dispatch} index={index} records={[]} />
          )}
        </aside>
        <main data-testid="widget">
          <WidgetWorkspace
            state={state}
            dispatch={dispatch}
            data={[]}
            messageRecords={[]}
            fieldIndex={index}
            info={null}
            sources={[]}
            fullEnd={1}
            revision={0}
            dragVerdict={() => null}
            widgetDrag={null}
            drop={() => {}}
            openSettings={() => {}}
          />
        </main>
      </div>
    </PlaybackContext.Provider>
  );
}

it.each(widgetTypes)("%s widget without data", async (widgetType) => {
  const state = reduce(initialWorkspace(), { type: "change-type", id: "widget-1", widgetType });
  render(<Workspace initialState={state} />);
  await expect.element(page.getByTestId("widget").getByRole("button").first()).toBeVisible();
  await expect(page.getByTestId("widget")).toMatchScreenshot(`${widgetType}-widget`);
  await expect(page.getByTestId("settings")).toMatchScreenshot(`${widgetType}-settings`);
});
