#!/usr/bin/env node

const request = require('request-promise-native');
const unpromisifiedRequest = require('request');
const url = require('url');
const cheerio = require('cheerio');
const fs = require('fs');
const parseArgs = require('minimist');

function usage(exitCode) {
  console.log(
    'Usage:\n\tnode download_album.js [OPTIONS] ALBUM_URL\n\n' +
      'Valid options are:\n' +
      '\t-h|--help\t\tGet this message\n' +
      '\t-d|--debug\t\tPrint stack trace on error\n' +
      '\t-s NUMBER\t\tNumber of tracks to be downloaded simultaneously (default: 5)\n' +
      '\t-t NUMBER\t\tDownload specific track number (useful if some track failed to download)'
  );
  process.exit(exitCode);
}

const argv = parseArgs(process.argv.slice(2), {
  alias: {
    help: 'h',
    debug: 'd',
    sim: 's',
    trackID: 't'
  },

  default: {
    help: false,
    debug: false,
    sim: 5,
    trackID: false
  },

  boolean: ['help', 'debug'],

  stopEarly: true,

  unknown: key => {
    if (!key.startsWith('-')) return;

    console.log(`Unknown key: ${key}\n`);
    usage(1);
  }
});

function processArgs(argv) {
  if (argv.help) usage(0);
  if (typeof argv.sim !== 'number') usage(1);

  const albumURL = argv._[0];
  const domain = url.parse(albumURL).hostname;
  const parallelDownloads = argv.sim;
  const isDebugMode = argv.debug;
  const trackID = argv.trackID;

  return { albumURL, domain, parallelDownloads, isDebugMode, trackID };
}

function getLinksAndTags(html, domain) {
  const $ = cheerio.load(html);

  const [album, artist = 'VA'] = $('h1')
    .text()
    .trim()
    .split(' - ', 2)
    .reverse();
  const tracksData = [];
  const $tracks = $('.playlist__item');
  const len = $tracks.length;
  const coverURL = $('.album-img').attr('data-src');

  $tracks.each((index, element) => {
    let trackNo = $(element)
      .find('.playlist__position')
      .text()
      .trim();
    if (trackNo.length < 2) trackNo = '0' + trackNo;

    tracksData.push({
      url: `https://${domain}${$(element)
        .find('.playlist__control.play')
        .attr('data-url')}`,
      trackNo,
      title: $(element)
        .find('.playlist__details a.strong')
        .text()
        .trim(),
      artist,
      album
    });
  });

  return { tracksData, coverURL };
}

function executeInChunks(callbackArgs, callback, queueSize = 5) {
  const execWith = async (element, index) => {
    await callback(element);
    return index;
  };

  // Form initial queue consisting of promises, which resolve with
  // their index number in the queue array.
  const queueArray = callbackArgs.splice(0, queueSize).map(execWith);

  // Recursively get rid of resolved promises in the queue.
  // Add new promises preventing queue from emptying.
  const keepQueueSize = async () => {
    if (callbackArgs.length) {
      try {
        const index = await Promise.race(queueArray);
        queueArray.splice(index, 1, execWith(callbackArgs.shift(), index));
        keepQueueSize();
      } catch (error) {
        console.log('Cannot assemble another chunk');
        throw error;
      }
    }
  };

  keepQueueSize();
}

function cleanUpSymbols(inputString) {
  return inputString.replace(/[:/\"*<>|?]/g, '');
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    unpromisifiedRequest({
      url,
      headers: {
        'User-Agent': 'request'
      }
    })
      .on('error', reject)
      .pipe(
        fs
          .createWriteStream(filename)
          .on('finish', resolve)
          .on('error', reject)
      );
  });
}

async function downloadTrack({ url, ...trackInfo }) {
  Object.keys(trackInfo).forEach(
    prop => (trackInfo[prop] = cleanUpSymbols(trackInfo[prop]))
  );

  const { artist, album, trackNo, title } = trackInfo;
  const filename = `${artist}/${album}/${trackNo} - ${title}.mp3`;

  console.log(`Starting download: ${trackNo} - ${title}`);

  try {
    const file = await downloadFile(url, filename);
    console.log(`Download is finished: ${trackNo} - ${title}`);
    return file;
  } catch (error) {
    console.log(`Download is failed: ${trackNo} - ${title}`);
    throw error;
  }
}

function prepareAlbumDir(tracksData) {
  return new Promise(resolve => {
    const artist = cleanUpSymbols(tracksData[0].artist);
    const album = cleanUpSymbols(tracksData[0].album);
    const albumDir = `${artist}/${album}`;

    // Check the existence of the target directory
    fs.access(albumDir, fs.constants.F_OK, error => {
      if (error) {
        fs.mkdir(`${artist}`, () => {
          fs.mkdir(albumDir, () => {
            resolve(albumDir);
          });
        });
      } else resolve(albumDir);
    });
  });
}

async function downloadCover(coverURL, albumDir) {
  const filename = `${albumDir}/cover.jpg`;

  try {
    const cover = await downloadFile(coverURL, filename);
    console.log('Cover is downloaded');
  } catch (error) {
    console.log('Failed to download cover');
    // throw error;
  }
}

(async () => {
  const {
    albumURL,
    domain,
    parallelDownloads,
    isDebugMode,
    trackID
  } = processArgs(argv);

  try {
    const body = await request({
      url: albumURL,
      headers: {
        'User-Agent': 'request'
      }
    });
    const { tracksData, coverURL } = getLinksAndTags(body, domain);
    const albumDir = await prepareAlbumDir(tracksData);

    if (trackID) {
      executeInChunks(tracksData.slice(trackID - 1, trackID), downloadTrack, 1);
      return;
    }

    await downloadCover(coverURL, albumDir);
    await executeInChunks(tracksData, downloadTrack, parallelDownloads);
  } catch (error) {
    console.log(`Failed to download the album: ${error}`);

    if (isDebugMode) {
      console.log(error.stack);
    }
  }
})();
