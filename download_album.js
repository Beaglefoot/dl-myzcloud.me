#!/bin/env node

const request = require('request');
const cheerio = require('cheerio');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));

function usage() {
  console.log('Usage:\n\tdownload_album.js [-h|--help] URL_TO_ALBUM');
}

if (argv.h || argv.help) {
  usage();
  process.exit(0);
}
else {
  const keys = Object.keys(argv);
  if (keys.length > 1 || argv._.length === 0) {
    keys.forEach(key => {
      if (key !== '_') console.log(`Unknown key: ${key}`);
    });
    usage();
    process.exit(1);
  }
}

const albumURL = process.argv[2];

request({
  url: albumURL,
  headers: {
    'User-Agent': 'request'
  }
}, function(error, response, body) {
  if (!error) getLinksAndTags(body, function(tracksData) {
    executeInChunks(tracksData, downloadFile);
  });
  else console.log(error);
});

function getLinksAndTags(html, callback) {
  const $ = cheerio.load(html);

  const [album, artist = 'VA'] = $('h1').text().trim().split(' - ', 2).reverse();
  const tracksData = [];
  const $tracks = $('.player-inline');
  const len = $tracks.length;

  $tracks.each(function(index) {
    let trackNo = $(this).find('.position').text().trim();
    if (trackNo.length < 2) trackNo = '0' + trackNo;

    tracksData.push({
      url: 'https://myzuka.fm' + $(this).find('span.ico').attr('data-url'),
      trackNo: trackNo,
      title: $(this).find('.details p').text().trim(),
      artist: artist,
      album: album
    });

    if (index === (len - 1)) callback(tracksData);
  });
}

function executeInChunks(array, callback, queueSize = 5) {
  // Form initial queue consisting of promises, which resolve with
  // their index number in the queue array.
  const queueArray = array.splice(0, queueSize).map(function(element, index) {
    return new Promise(function(resolve, reject) {
      callback(element)
        .then(function() {
          resolve(index);
        })
        .catch(function(err) {
          reject();
          throw err;
        });
    });
  });

  // Recursively get rid of resolved promises in the queue.
  // Add new promises preventing queue from emptying.
  function keepQueueSize() {
    if (array.length) {
      Promise.race(queueArray)
        .then(function(index) {
          queueArray.splice(index, 1, new Promise(function(resolve) {
            callback(array.shift())
              .then(function() {
                resolve(index);
              });
          }));
          keepQueueSize();
        })
        .catch(function() {
          console.log('Cannot assemble another chunk');
        });
    }
  }

  keepQueueSize();
}

function downloadFile(trackInfo) {
  return new Promise(function(resolve, reject) {

    trackInfo.artist = cleanUpSymbols(trackInfo.artist);
    trackInfo.album = cleanUpSymbols(trackInfo.album);
    trackInfo.trackNo = cleanUpSymbols(trackInfo.trackNo);
    trackInfo.title = cleanUpSymbols(trackInfo.title);

    const filename = `${trackInfo.artist}/${trackInfo.album}/${trackInfo.trackNo} - ${trackInfo.title}.mp3`;

    function cleanUpSymbols(inputString) {
      return inputString.replace(/[:/\"<>|]/g, '');
    }

    function requestAndWrite() {
      console.log(`Starting download: ${trackInfo.trackNo} - ${trackInfo.title}`);
      request({
        url: trackInfo.url,
        headers: {
          'User-Agent': 'request'
        }
      })
        .on('error', function(error) {
          console.log(error);
          reject(error);
        })
        .pipe(fs.createWriteStream(filename)
          .on('finish', function() {
            console.log(`Download is finished: ${trackInfo.trackNo} - ${trackInfo.title}`);
            resolve();
          })
          .on('error', function(error) {
            console.log(`Download is failed: ${trackInfo.trackNo} - ${trackInfo.title}`);
            reject(error);
          }));
    }

    // Check the existence of the target directory
    fs.access(`${trackInfo.artist}/${trackInfo.album}`, fs.constants.F_OK, function(error) {
      if (error) {
        fs.mkdir(`${trackInfo.artist}`, function() {
          fs.mkdir(`${trackInfo.artist}/${trackInfo.album}`, function() {
            requestAndWrite();
          });
        });
      }
      else requestAndWrite();
    });
  });
}
