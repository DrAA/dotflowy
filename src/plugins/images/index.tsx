import { ImageIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button, Dialog, DialogContent, DialogTitle } from "@/plugins/kit";

import type { Node } from "../../data/tree";
import type { PluginContext } from "../types";

import {
  attachImages,
  detachMedia,
  getMediaRows,
  mediaForNode,
  mediaUrl,
  nodeHasImage,
  pickAndAttachImages,
  startMedia,
  useMediaOverlays,
  useMediaRows,
  type MediaOverlay,
  type MediaRow,
} from "../../data/media";
import { trueSourceOf } from "../../data/tree";
import { getTreeIndex } from "../../data/tree-store";
import { definePlugin } from "../types";

function NodeImages({
  node,
  getCtx,
}: {
  node: Node;
  getCtx: () => PluginContext;
}) {
  const rows = useMediaRows();
  const overlays = useMediaOverlays();
  const contentId = trueSourceOf(getTreeIndex(), node.id);
  const attached = mediaForNode(contentId, rows);
  const pending = overlays.filter((o) => o.nodeId === contentId);
  const [openId, setOpenId] = useState<string | null>(null);
  const openRow = attached.find((r) => r.id === openId) ?? null;
  if (attached.length === 0 && pending.length === 0) return null;
  return (
    <div className="node-images">
      {pending.map((o) => (
        <ImageBlock key={o.tempId} overlay={o} />
      ))}
      {attached.map((row) => (
        <ImageBlock
          key={row.id}
          row={row}
          onOpen={() => setOpenId(row.id)}
          onDetach={() => detachMedia(row.id, getCtx())}
        />
      ))}
      <Dialog
        open={openRow !== null}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
      >
        <DialogContent className="max-w-[min(90vw,960px)] p-2">
          <DialogTitle className="sr-only">Attached image</DialogTitle>
          {openRow && (
            <img
              src={mediaUrl(openRow.id)}
              alt=""
              className="max-h-[85vh] w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ImageBlock({
  row,
  overlay,
  onOpen,
  onDetach,
}: {
  row?: MediaRow;
  overlay?: MediaOverlay;
  onOpen?: () => void;
  onDetach?: () => void;
}) {
  const src = overlay?.url ?? (row ? mediaUrl(row.id) : "");
  const width = overlay?.width ?? row?.width ?? 0;
  const height = overlay?.height ?? row?.height ?? 0;
  const ratio =
    width > 0 && height > 0
      ? { aspectRatio: `${width} / ${height}` }
      : undefined;
  return (
    <div className="node-image">
      <button
        type="button"
        className="node-image-hit"
        onClick={onOpen}
        disabled={!onOpen}
      >
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            width={width || undefined}
            height={height || undefined}
            style={ratio}
          />
        ) : (
          <span className="node-image-pending" style={ratio} />
        )}
      </button>
      {onDetach && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="node-image-detach"
          aria-label="Remove image"
          onClick={(e) => {
            e.stopPropagation();
            onDetach();
          }}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

export default definePlugin({
  id: "images",

  preload: startMedia,

  slots: [
    {
      id: "images-below",
      position: "row:below",
      render: (node, getCtx) => <NodeImages node={node} getCtx={getCtx} />,
    },
    {
      id: "images-below-title",
      position: "title:below",
      render: (node, getCtx) => <NodeImages node={node} getCtx={getCtx} />,
    },
  ],

  input: {
    onPasteFiles: ({ files, nodeId }, ctx) => attachImages(files, nodeId, ctx),
  },

  commands: [
    {
      id: "image",
      label: "Image",
      description: "Attach an image under this bullet",
      icon: ImageIcon,
      keywords: ["image", "photo", "picture", "screenshot", "attach"],
      available: () => true,
      run: (nodeId, ctx) => pickAndAttachImages(nodeId, ctx),
    },
  ],

  filterOperators: [
    {
      key: "has",
      values: ["image"],
      description: "Filter to nodes with an attached image",
      predicate: (node) => {
        startMedia();
        return nodeHasImage(
          trueSourceOf(getTreeIndex(), node.id),
          getMediaRows(),
        );
      },
    },
  ],
});
