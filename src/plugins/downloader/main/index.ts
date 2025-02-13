import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { app, BrowserWindow, dialog } from 'electron';
import {
  ClientType,
  Innertube,
  UniversalCache,
  Utils,
  YTNodes,
} from 'youtubei.js';
import is from 'electron-is';
import filenamify from 'filenamify';
import { Mutex } from 'async-mutex';
import { createFFmpeg } from '@ffmpeg.wasm/main';
import NodeID3, { TagConstants } from 'node-id3';

import {
  cropMaxWidth,
  getFolder,
  sendFeedback as sendFeedback_,
  setBadge,
} from './utils';

import { fetchFromGenius } from '@/plugins/lyrics-genius/main';
import { isEnabled } from '@/config/plugins';
import { cleanupName, getImage, SongInfo } from '@/providers/song-info';
import { getNetFetchAsFetch } from '@/plugins/utils/main';
import { cache } from '@/providers/decorators';

import { t } from '@/i18n';

import { YoutubeFormatList, type Preset, DefaultPresetList } from '../types';

import type { DownloaderPluginConfig } from '../index';

import type { BackendContext } from '@/types/contexts';

import type { FormatOptions } from 'youtubei.js/dist/src/types/FormatUtils';
import type PlayerErrorMessage from 'youtubei.js/dist/src/parser/classes/PlayerErrorMessage';
import type { Playlist } from 'youtubei.js/dist/src/parser/ytmusic';
import type { VideoInfo } from 'youtubei.js/dist/src/parser/youtube';
import type TrackInfo from 'youtubei.js/dist/src/parser/ytmusic/TrackInfo';

import type { GetPlayerResponse } from '@/types/get-player-response';

type CustomSongInfo = SongInfo & { trackId?: string };

const ffmpeg = createFFmpeg({
  log: false,
  logger() {}, // Console.log,
  progress() {}, // Console.log,
});
const ffmpegMutex = new Mutex();

let yt: Innertube;
let win: BrowserWindow;
let playingUrl: string;

const sendError = (error: Error, source?: string) => {
  win.setProgressBar(-1); // Close progress bar
  setBadge(0); // Close badge
  sendFeedback_(win); // Reset feedback

  const songNameMessage = source ? `\nin ${source}` : '';
  const cause = error.cause ? `\n\n${String(error.cause)}` : '';
  const message = `${error.toString()}${songNameMessage}${cause}`;

  console.error(message);
  console.trace(error);
  dialog.showMessageBox(win, {
    type: 'info',
    buttons: [t('plugins.downloader.backend.dialog.error.buttons.ok')],
    title: t('plugins.downloader.backend.dialog.error.title'),
    message: t('plugins.downloader.backend.dialog.error.message'),
    detail: message,
  });
};

export const getCookieFromWindow = async (win: BrowserWindow) => {
  return (
    await win.webContents.session.cookies.get({
      url: 'https://music.youtube.com',
    })
  )
    .map((it) => it.name + '=' + it.value)
    .join(';');
};

let config: DownloaderPluginConfig;

export const onMainLoad = async ({
  window: _win,
  getConfig,
  ipc,
}: BackendContext<DownloaderPluginConfig>) => {
  win = _win;
  config = await getConfig();

  yt = await Innertube.create({
    cache: new UniversalCache(false),
    cookie: await getCookieFromWindow(win),
    generate_session_locally: true,
    fetch: getNetFetchAsFetch(),
  });
  ipc.handle('download-song', (url: string) => downloadSong(url));
  ipc.on('video-src-changed', (data: GetPlayerResponse) => {
    playingUrl = data.microformat.microformatDataRenderer.urlCanonical;
  });
  ipc.handle('download-playlist-request', async (url: string) =>
    downloadPlaylist(url),
  );
};

export const onConfigChange = (newConfig: DownloaderPluginConfig) => {
  config = newConfig;
};

export async function downloadSong(
  url: string,
  playlistFolder: string | undefined = undefined,
  trackId: string | undefined = undefined,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  let resolvedName;
  try {
    await downloadSongUnsafe(
      false,
      url,
      (name: string) => (resolvedName = name),
      playlistFolder,
      trackId,
      increasePlaylistProgress,
    );
  } catch (error: unknown) {
    sendError(error as Error, resolvedName || url);
  }
}

export async function downloadSongFromId(
  id: string,
  playlistFolder: string | undefined = undefined,
  trackId: string | undefined = undefined,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  let resolvedName;
  try {
    await downloadSongUnsafe(
      true,
      id,
      (name: string) => (resolvedName = name),
      playlistFolder,
      trackId,
      increasePlaylistProgress,
    );
  } catch (error: unknown) {
    sendError(error as Error, resolvedName || id);
  }
}

async function downloadSongUnsafe(
  isId: boolean,
  idOrUrl: string,
  setName: (name: string) => void,
  playlistFolder: string | undefined = undefined,
  trackId: string | undefined = undefined,
  increasePlaylistProgress: (value: number) => void = () => {},
) {
  const sendFeedback = (message: unknown, progress?: number) => {
    if (!playlistFolder) {
      sendFeedback_(win, message);
      if (progress && !isNaN(progress)) {
        win.setProgressBar(progress);
      }
    }
  };

  sendFeedback(t('plugins.downloader.backend.feedback.downloading'), 2);

  let id: string | null;
  if (isId) {
    id = idOrUrl;
  } else {
    id = getVideoId(idOrUrl);
    if (typeof id !== 'string')
      throw new Error(
        t('plugins.downloader.backend.feedback.video-id-not-found'),
      );
  }

  let info: TrackInfo | VideoInfo = await yt.music.getInfo(id);

  if (!info) {
    throw new Error(
      t('plugins.downloader.backend.feedback.video-id-not-found'),
    );
  }

  const metadata = getMetadata(info);
  if (metadata.album === 'N/A') {
    metadata.album = '';
  }

  metadata.trackId = trackId;

  const dir =
    playlistFolder || config.downloadFolder || app.getPath('downloads');
  const name = `${metadata.artist ? `${metadata.artist} - ` : ''}${
    metadata.title
  }`;
  setName(name);

  let playabilityStatus = info.playability_status;
  let bypassedResult = null;
  if (playabilityStatus.status === 'LOGIN_REQUIRED') {
    // Try to bypass the age restriction
    bypassedResult = await getAndroidTvInfo(id);
    playabilityStatus = bypassedResult.playability_status;

    if (playabilityStatus.status === 'LOGIN_REQUIRED') {
      throw new Error(
        `[${playabilityStatus.status}] ${playabilityStatus.reason}`,
      );
    }

    info = bypassedResult;
  }

  if (playabilityStatus.status === 'UNPLAYABLE') {
    const errorScreen =
      playabilityStatus.error_screen as PlayerErrorMessage | null;
    throw new Error(
      `[${playabilityStatus.status}] ${errorScreen?.reason.text}: ${errorScreen?.subreason.text}`,
    );
  }

  const selectedPreset = config.selectedPreset ?? 'mp3 (256kbps)';
  let presetSetting: Preset;
  if (selectedPreset === 'Custom') {
    presetSetting = config.customPresetSetting ?? DefaultPresetList['Custom'];
  } else if (selectedPreset === 'Source') {
    presetSetting = DefaultPresetList['Source'];
  } else {
    presetSetting = DefaultPresetList['mp3 (256kbps)'];
  }

  const downloadOptions: FormatOptions = {
    type: 'audio', // Audio, video or video+audio
    quality: 'best', // Best, bestefficiency, 144p, 240p, 480p, 720p and so on.
    format: 'any', // Media container format
  };

  const format = info.chooseFormat(downloadOptions);

  let targetFileExtension: string;
  if (!presetSetting?.extension) {
    targetFileExtension =
      YoutubeFormatList.find((it) => it.itag === format.itag)?.container ??
      'mp3';
  } else {
    targetFileExtension = presetSetting?.extension ?? 'mp3';
  }

  let filename = filenamify(`${name}.${targetFileExtension}`, {
    replacement: '_',
    maxLength: 255,
  });
  if (!is.macOS()) {
    filename = filename.normalize('NFC');
  }
  const filePath = join(dir, filename);

  if (config.skipExisting && existsSync(filePath)) {
    sendFeedback(null, -1);
    return;
  }

  const stream = await info.download(downloadOptions);

  console.info(
    t('plugins.downloader.backend.feedback.download-info', {
      artist: metadata.artist,
      title: metadata.title,
      videoId: metadata.videoId,
    }),
  );

  const iterableStream = Utils.streamToIterable(stream);

  if (!existsSync(dir)) {
    mkdirSync(dir);
  }

  const fileBuffer = await iterableStreamToTargetFile(
    iterableStream,
    targetFileExtension,
    metadata,
    presetSetting?.ffmpegArgs ?? [],
    format.content_length ?? 0,
    sendFeedback,
    increasePlaylistProgress,
  );

  if (fileBuffer) {
    if (targetFileExtension !== 'mp3') {
      createWriteStream(filePath).write(fileBuffer);
    } else {
      const buffer = await writeID3(
        Buffer.from(fileBuffer),
        metadata,
        sendFeedback,
      );
      if (buffer) {
        writeFileSync(filePath, buffer);
      }
    }
  }

  sendFeedback(null, -1);
  console.info(
    t('plugins.downloader.backend.feedback.done', {
      filePath,
    }),
  );
}

async function iterableStreamToTargetFile(
  stream: AsyncGenerator<Uint8Array, void>,
  extension: string,
  metadata: CustomSongInfo,
  presetFfmpegArgs: string[],
  contentLength: number,
  sendFeedback: (str: string, value?: number) => void,
  increasePlaylistProgress: (value: number) => void = () => {},
): Promise<Uint8Array | null> {
  const chunks = [];
  let downloaded = 0;
  for await (const chunk of stream) {
    downloaded += chunk.length;
    chunks.push(chunk);
    const ratio = downloaded / contentLength;
    const progress = Math.floor(ratio * 100);
    sendFeedback(
      t('plugins.downloader.backend.feedback.download-progress', {
        percent: progress,
      }),
      ratio,
    );
    // 15% for download, 85% for conversion
    // This is a very rough estimate, trying to make the progress bar look nice
    increasePlaylistProgress(ratio * 0.15);
  }

  sendFeedback(t('plugins.downloader.backend.feedback.loading'), 2); // Indefinite progress bar after download

  const buffer = Buffer.concat(chunks);
  const safeVideoName = randomBytes(32).toString('hex');
  const releaseFFmpegMutex = await ffmpegMutex.acquire();

  try {
    if (!ffmpeg.isLoaded()) {
      await ffmpeg.load();
    }

    sendFeedback(t('plugins.downloader.backend.feedback.preparing-file'));
    ffmpeg.FS('writeFile', safeVideoName, buffer);

    sendFeedback(t('plugins.downloader.backend.feedback.converting'));

    ffmpeg.setProgress(({ ratio }) => {
      sendFeedback(
        t('plugins.downloader.backend.feedback.conversion-progress', {
          percent: Math.floor(ratio * 100),
        }),
        ratio,
      );
      increasePlaylistProgress(0.15 + (ratio * 0.85));
    });

    const safeVideoNameWithExtension = `${safeVideoName}.${extension}`;
    try {
      await ffmpeg.run(
        '-i',
        safeVideoName,
        ...presetFfmpegArgs,
        ...getFFmpegMetadataArgs(metadata),
        safeVideoNameWithExtension,
      );
    } finally {
      ffmpeg.FS('unlink', safeVideoName);
    }

    sendFeedback(t('plugins.downloader.backend.feedback.saving'));

    try {
      return ffmpeg.FS('readFile', safeVideoNameWithExtension);
    } finally {
      ffmpeg.FS('unlink', safeVideoNameWithExtension);
    }
  } catch (error: unknown) {
    sendError(error as Error, safeVideoName);
  } finally {
    releaseFFmpegMutex();
  }
  return null;
}

const getCoverBuffer = cache(async (url: string) => {
  const nativeImage = cropMaxWidth(await getImage(url));
  return nativeImage && !nativeImage.isEmpty() ? nativeImage.toPNG() : null;
});

async function writeID3(
  buffer: Buffer,
  metadata: CustomSongInfo,
  sendFeedback: (str: string, value?: number) => void,
) {
  try {
    sendFeedback(t('plugins.downloader.backend.feedback.writing-id3'));
    const tags: NodeID3.Tags = {};

    // Create the metadata tags
    tags.title = metadata.title;
    tags.artist = metadata.artist;

    if (metadata.album) {
      tags.album = metadata.album;
    }

    const coverBuffer = await getCoverBuffer(metadata.imageSrc ?? '');
    if (coverBuffer) {
      tags.image = {
        mime: 'image/png',
        type: {
          id: TagConstants.AttachedPicture.PictureType.FRONT_COVER,
        },
        description: 'thumbnail',
        imageBuffer: coverBuffer,
      };
    }

    if (isEnabled('lyrics-genius')) {
      const lyrics = await fetchFromGenius(metadata);
      if (lyrics) {
        tags.unsynchronisedLyrics = {
          language: '',
          text: lyrics,
        };
      }
    }

    if (metadata.trackId) {
      tags.trackNumber = metadata.trackId;
    }

    return NodeID3.write(tags, buffer);
  } catch (error: unknown) {
    sendError(error as Error, `${metadata.artist} - ${metadata.title}`);
    return null;
  }
}

export async function downloadPlaylist(givenUrl?: string | URL) {
  try {
    givenUrl = new URL(givenUrl ?? '');
  } catch {
    givenUrl = new URL(win.webContents.getURL());
  }

  const playlistId =
    getPlaylistID(givenUrl) || getPlaylistID(new URL(playingUrl));

  if (!playlistId) {
    sendError(
      new Error(t('plugins.downloader.backend.feedback.playlist-id-not-found')),
    );
    return;
  }

  const sendFeedback = (message?: unknown) => sendFeedback_(win, message);

  console.log(
    t('plugins.downloader.backend.feedback.trying-to-get-playlist-id', {
      playlistId,
    }),
  );
  sendFeedback(t('plugins.downloader.backend.feedback.getting-playlist-info'));
  let playlist: Playlist;
  const items: YTNodes.MusicResponsiveListItem[] = [];
  try {
    playlist = await yt.music.getPlaylist(playlistId);
    if (playlist?.items) {
      items.push(...playlist.items.as(YTNodes.MusicResponsiveListItem));
    }
  } catch (error: unknown) {
    sendError(
      Error(
        t('plugins.downloader.backend.feedback.playlist-is-mix-or-private', {
          error: String(error),
        }),
      ),
    );
    return;
  }

  if (!playlist || !playlist.items || playlist.items.length === 0) {
    sendError(
      new Error(t('plugins.downloader.backend.feedback.playlist-is-empty')),
    );
  }

  const normalPlaylistTitle = playlist.header?.title?.text;
  const playlistTitle =
    normalPlaylistTitle ??
    playlist.page.contents_memo
      ?.get('MusicResponsiveListItemFlexColumn')
      ?.at(2)
      ?.as(YTNodes.MusicResponsiveListItemFlexColumn)?.title?.text ??
    'NO_TITLE';
  const isAlbum = !normalPlaylistTitle;

  while (playlist.has_continuation) {
    playlist = await playlist.getContinuation();
    if (playlist?.items) {
      items.push(...playlist.items.as(YTNodes.MusicResponsiveListItem));
    }
  }

  if (items.length === 1) {
    sendFeedback(
      t('plugins.downloader.backend.feedback.playlist-has-only-one-song'),
    );
    await downloadSongFromId(items.at(0)!.id!);
    return;
  }

  let safePlaylistTitle = filenamify(playlistTitle, { replacement: ' ' });
  if (!is.macOS()) {
    safePlaylistTitle = safePlaylistTitle.normalize('NFC');
  }

  const folder = getFolder(config.downloadFolder ?? '');
  const playlistFolder = join(folder, safePlaylistTitle);
  if (existsSync(playlistFolder)) {
    if (!config.skipExisting) {
      sendError(
        new Error(
          t('plugins.downloader.backend.feedback.folder-already-exists', {
            playlistFolder,
          }),
        ),
      );
      return;
    }
  } else {
    mkdirSync(playlistFolder, { recursive: true });
  }

  dialog.showMessageBox(win, {
    type: 'info',
    buttons: [
      t('plugins.downloader.backend.dialog.start-download-playlist.buttons.ok'),
    ],
    title: t('plugins.downloader.backend.dialog.start-download-playlist.title'),
    message: t(
      'plugins.downloader.backend.dialog.start-download-playlist.message',
      {
        playlistTitle,
      },
    ),
    detail: t(
      'plugins.downloader.backend.dialog.start-download-playlist.detail',
      {
        playlistSize: items.length,
      },
    ),
  });

  if (is.dev()) {
    console.log(
      t('plugins.downloader.backend.feedback.downloading-playlist', {
        playlistTitle,
        playlistSize: items.length,
        playlistId,
      }),
    );
  }

  win.setProgressBar(2); // Starts with indefinite bar

  setBadge(items.length);

  let counter = 1;

  const progressStep = 1 / items.length;

  const increaseProgress = (itemPercentage: number) => {
    const currentProgress = (counter - 1) / (items.length ?? 1);
    const newProgress = currentProgress + (progressStep * itemPercentage);
    win.setProgressBar(newProgress);
  };

  try {
    for (const song of items) {
      sendFeedback(
        t('plugins.downloader.backend.feedback.downloading-counter', {
          current: counter,
          total: items.length,
        }),
      );
      const trackId = isAlbum ? counter : undefined;
      await downloadSongFromId(
        song.id!,
        playlistFolder,
        trackId?.toString(),
        increaseProgress,
      ).catch((error) =>
        sendError(
          new Error(
            t('plugins.downloader.backend.feedback.error-while-downloading', {
              author: song.author!.name,
              title: song.title!,
              error: String(error),
            }),
          ),
        ),
      );

      win.setProgressBar(counter / items.length);
      setBadge(items.length - counter);
      counter++;
    }
  } catch (error: unknown) {
    sendError(error as Error);
  } finally {
    win.setProgressBar(-1); // Close progress bar
    setBadge(0); // Close badge counter
    sendFeedback(); // Clear feedback
  }
}

function getFFmpegMetadataArgs(metadata: CustomSongInfo) {
  if (!metadata) {
    return [];
  }

  return [
    ...(metadata.title ? ['-metadata', `title=${metadata.title}`] : []),
    ...(metadata.artist ? ['-metadata', `artist=${metadata.artist}`] : []),
    ...(metadata.album ? ['-metadata', `album=${metadata.album}`] : []),
    ...(metadata.trackId ? ['-metadata', `track=${metadata.trackId}`] : []),
  ];
}

// Playlist radio modifier needs to be cut from playlist ID
const INVALID_PLAYLIST_MODIFIER = 'RDAMPL';

const getPlaylistID = (aURL?: URL): string | null | undefined => {
  const result =
    aURL?.searchParams.get('list') || aURL?.searchParams.get('playlist');
  if (result?.startsWith(INVALID_PLAYLIST_MODIFIER)) {
    return result.slice(INVALID_PLAYLIST_MODIFIER.length);
  }

  return result;
};

const getVideoId = (url: URL | string): string | null => {
  return new URL(url).searchParams.get('v');
};

const getMetadata = (info: TrackInfo): CustomSongInfo => ({
  videoId: info.basic_info.id!,
  title: cleanupName(info.basic_info.title!),
  artist: cleanupName(info.basic_info.author!),
  album: info.player_overlays?.browser_media_session?.as(
    YTNodes.BrowserMediaSession,
  ).album?.text,
  imageSrc: info.basic_info.thumbnail?.find((t) => !t.url.endsWith('.webp'))
    ?.url,
  views: info.basic_info.view_count!,
  songDuration: info.basic_info.duration!,
});

// This is used to bypass age restrictions
const getAndroidTvInfo = async (id: string): Promise<VideoInfo> => {
  const innertube = await Innertube.create({
    client_type: ClientType.TV_EMBEDDED,
    generate_session_locally: true,
    retrieve_player: true,
    fetch: getNetFetchAsFetch(),
  });
  // GetInfo 404s with the bypass, so we use getBasicInfo instead
  // that's fine as we only need the streaming data
  return await innertube.getBasicInfo(id, 'TV_EMBEDDED');
};
