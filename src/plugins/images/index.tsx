import { ImageIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

const PREVIEW_ZOOM_MIN = 1;
const PREVIEW_ZOOM_MAX = 8;
const PREVIEW_ZOOM_FACTOR = 1.12;

function ImagePreview({ src }: { src: string }) {
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const captureFit = () => {
    const img = imgRef.current;
    if (!img || img.clientWidth === 0) return;
    setFit({ w: img.clientWidth, h: img.clientHeight });
  };

  // Cached images may skip onLoad; measure after the fit layout paints.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (imgRef.current?.complete) captureFit();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  // Non-passive: Ctrl+wheel must preventDefault or the browser page-zooms.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const factor =
        e.deltaY < 0 ? PREVIEW_ZOOM_FACTOR : 1 / PREVIEW_ZOOM_FACTOR;
      setZoom((z) =>
        Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, z * factor)),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={scrollerRef}
      className="max-h-[95vh] overflow-auto overscroll-contain"
    >
      <div
        className="relative mx-auto"
        style={fit ? { width: fit.w * zoom, height: fit.h * zoom } : undefined}
      >
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          onLoad={captureFit}
          className="block object-contain"
          style={
            fit
              ? {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: fit.w,
                  height: fit.h,
                  maxWidth: "none",
                  transform: `scale(${zoom})`,
                  transformOrigin: "top left",
                }
              : {
                  width: "100%",
                  maxHeight: "95vh",
                }
          }
        />
      </div>
    </div>
  );
}

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
        <DialogContent
          // `sm:max-w-*` (not a bare `max-w-*`): DialogContent's base
          // `sm:max-w-sm` outlives any unprefixed max-width at that breakpoint.
          className="w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] p-1 sm:max-w-[calc(100vw-1rem)]"
        >
          <DialogTitle className="sr-only">Attached image</DialogTitle>
          {openRow && (
            <ImagePreview key={openRow.id} src={mediaUrl(openRow.id)} />
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
          // Eager, not lazy: the row is already windowed, and translateY
          // puts every row at layout top 0, so Edge treats in-view images
          // as off-screen until a later scroll or a reload.
          <img
            src={src}
            alt=""
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
