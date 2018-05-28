#!/usr/bin/env node

const request = require('request-promise-native');
const url = require('url');
const cheerio = require('cheerio');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));



// Handle command line arguments and etc.
function usage(exitCode) {
  console.log(
    'Usage:\n\tdownload_album.js [OPTIONS] ALBUM_URL\n\n' +
    'Valid options are:\n' +
    '\t-h|--help\t\tGet this message\n' +
    '\t-s NUMBER\t\tNumber of tracks to be downloaded simultaneously (default: 5)'
  );
  process.exit(exitCode);
}

let parallelDownloads = 5;
const knownKeys = {
  help() {
    usage(0);
  },
  h() {
    this.help();
  },
  s(num) {
    typeof num === 'number' ? parallelDownloads = argv.s : usage(1);
  }
};

const providedKeys = Object.keys(argv).filter(key => key !== '_');
const unknownKeys = providedKeys.filter(key => !knownKeys[key]);

if (unknownKeys.length || argv._.length !== 1) {
  unknownKeys.forEach(key => {
    console.log(`Unknown key: ${key}`);
  });

  usage(1);
}

providedKeys.forEach(key => {
  knownKeys[key](argv[key]);
});



const albumURL = argv._[0];
const domain = url.parse(albumURL).hostname;



function getLinksAndTags(html, domain) {
  const $ = cheerio.load(html);

  const [album, artist = 'VA'] = $('h1').text().trim().split(' - ', 2).reverse();
  const tracksData = [];
  const $tracks = $('.playlist__item');
  const len = $tracks.length;
  const coverURL = $('.album-img').attr('src');

  $tracks.each((index, element) => {
    let trackNo = $(element).find('.playlist__position').text().trim();
    if (trackNo.length < 2) trackNo = '0' + trackNo;

    tracksData.push({
      url: `https://${domain}${$(element).find('.playlist__control.play').attr('data-url')}`,
      trackNo,
      title: $(element).find('.playlist__details a.strong').text().trim(),
      artist,
      album
    });
  });

  return { tracksData, coverURL };
}

function executeInChunks(array, callback, queueSize = 5) {
  const execWith = async (element, index) => {
    await callback(element);
    return index;
  };

  // Form initial queue consisting of promises, which resolve with
  // their index number in the queue array.
  const queueArray = array.splice(0, queueSize).map(execWith);

  // Recursively get rid of resolved promises in the queue.
  // Add new promises preventing queue from emptying.
  const keepQueueSize = async () => {
    if (array.length) {
      try {
        const index = await Promise.race(queueArray);
        queueArray.splice(index, 1, execWith(array.shift(), index));
        keepQueueSize();
      }
      catch(error) {
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
    request({
      url,
      headers: {
        'User-Agent': 'request'
      }
    })
      .on('error', error => {
        console.log(error);
        reject(error);
      })
      .pipe(
        fs.createWriteStream(filename)
          .on('finish', resolve)
          .on('error', reject)
      );
  });
}

function downloadTrack(trackInfo) {
  trackInfo.artist = cleanUpSymbols(trackInfo.artist);
  trackInfo.album = cleanUpSymbols(trackInfo.album);
  trackInfo.trackNo = cleanUpSymbols(trackInfo.trackNo);
  trackInfo.title = cleanUpSymbols(trackInfo.title);

  const filename = `${trackInfo.artist}/${trackInfo.album}/${trackInfo.trackNo} - ${trackInfo.title}.mp3`;

  console.log(`Starting download: ${trackInfo.trackNo} - ${trackInfo.title}`);

  return downloadFile(trackInfo.url, filename)
    .then(() => {
      console.log(`Download is finished: ${trackInfo.trackNo} - ${trackInfo.title}`);
      return Promise.resolve();
    })
    .catch(error => {
      console.log(`Download is failed: ${trackInfo.trackNo} - ${trackInfo.title}`);
      return Promise.reject(error);
    });
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
      }
      else resolve(albumDir);
    });
  });
}

function downloadCover(coverURL, albumDir) {
  const filename = `${albumDir}/cover.jpg`;

  return downloadFile(coverURL, filename)
    .then(() => {
      console.log('Cover is downloaded');
      return Promise.resolve();
    })
    .catch(error => {
      console.log('Failed to download cover');
      return Promise.reject(error);
    });
}



(async () => {
  try {
    const body = await request({
      url: albumURL,
      headers: {
        'User-Agent': 'request'
      }
    });
    const { tracksData, coverURL } = getLinksAndTags(body, domain);
    const albumDir = await prepareAlbumDir(tracksData);

    await downloadCover(coverURL, albumDir);
    await executeInChunks(tracksData, downloadTrack, parallelDownloads);
  }
  catch(error) {
    console.log(`Failed to download the album: ${error}`);
  }
})();
