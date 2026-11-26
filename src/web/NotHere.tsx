// Now playing for a Video that is Not on this machine (sharing-spec §7.1): where the Player would be, a panel over the
// blurred poster with the message and the Video's source link. Play.tsx swaps it for the Player as soon as its poll sees
// a Copy (a scan found the file), the way the unmounted overlay gives way today.
import type { VideoDto } from "../shared/types";
import { NOT_HERE_MESSAGE, sourceLink } from "../shared/presence";
import { PanelDownload } from "./cardDownload";

/**
 * home-server-spec §5.2: a Video On the Home Server. Streaming it is the next step (§5.4, #241); until then Now playing
 * says where it is instead of opening a Player with no Copy to play.
 */
export function OnHomePanel({ video }: { video: VideoDto }) {
  const server = video.home?.server ?? "the Home Server";
  return (
    <div class="nothere-panel" role="status" data-onhome="">
      {video.thumbnail && <img class="bg" src={video.thumbnail.poster} alt="" />}
      <div class="box">
        <h3>On the Home Server</h3>
        <p>
          This Video's file is on {server}, not on this Mac. Playing it from there is not built yet.
          {video.homeOnly && " It is shown here read-only, with the Home Server's titles, Type and Chapters."}
        </p>
      </div>
    </div>
  );
}

export function NotHerePanel({ video }: { video: VideoDto }) {
  const link = sourceLink(video);
  return (
    <div class="nothere-panel" role="status" data-nothere="">
      {video.thumbnail && <img class="bg" src={video.thumbnail.poster} alt="" />}
      <div class="box">
        <h3>Not on this machine</h3>
        <p>{NOT_HERE_MESSAGE}</p>
        {link ? (
          <p>
            {link.site}:{" "}
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
            </a>
          </p>
        ) : (
          <p class="dim">No source link is known for this Video.</p>
        )}
        {/* downloader-spec §8: the card's Download button beside the source link, with the same states. */}
        {link && (
          <p class="cdl-panel-row">
            <PanelDownload video={video} />
          </p>
        )}
      </div>
    </div>
  );
}
