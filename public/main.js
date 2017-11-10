var d3 = require('d3');
var d3TimeFormat = require('d3-time-format');

var socket = io();

var config;

var pixelData;
var canvasContext, canvasBase;
var pixelSize = 7;
var pixelPadding = 1
var pixelTotalSize = pixelSize+pixelPadding;

var nextRuntime = 0;
tick();

var listItems, playlist = d3.select('#playlist').append('svg');

socket.io.on('connect_error', function(error) {
    d3.select('#status-message').text('Disconnected');
});

socket.io.on('reconnect', function(event) {
    d3.select('#status-message').text('');
});



socket.on('config', function(d){
    config = d;
    console.log('config', config);
    nextRuntime = new Date(config.nextRuntime);
    buildPlaylist(config.songs);
    pixelData = preparePixelData(config.numPixels);
    createCanvas('#pixels');
    bindPixelData(pixelData);
    drawPixels();
});

socket.on('pixelData', function(data) {
    pixelData = data;
    bindPixelData(pixelData);
    drawPixels();
});

socket.on('nextRuntime', function(data){
    nextRuntime = new Date(data);
});

socket.on('endOfFile', function(i){
    config.songs[i].playing = false;
    updateListItems();
});
socket.on('play', function(i){
    config.songs[i].playing = true;
    updateListItems();
});
socket.on('stop', function(i){
    config.songs[i].playing = false;
    updateListItems();
});

document.querySelector('#cancelButton').addEventListener('click', function(event){
    nextRuntime = 0;
    socket.emit('disableSchedulePlay');
    d3.select('#clock-container').classed('hidden', true);
});

function buildPlaylist(songs){
    
    var rowHeight = 40;
    var rectLeftOffset = 20;
    
    var bodyWidth = parseInt(d3.select('body').style('width'));
    
    var rectMaxWidth = bodyWidth - rectLeftOffset;
    
    d3.select('#playlist > svg')
        .attr('height', rowHeight*songs.length)
        .attr('width', bodyWidth);
    
    
    
    listItems = playlist.selectAll('g')
        .data(songs)
        .enter()
        .append('g')
        .attr('transform', function(d, i) {        
            return "translate(0," + (((i+1) * rowHeight) - (rowHeight/2)) + ")";
        });
    
    //play/stop buttons
    listItems
        .append('text')
        .attr('class', 'play-stop-button')
        .text(getListItemButton)
        .on('click', function(d, i){
            if(d.playing){
                socket.emit('stop');
            }else{
                socket.emit('playSong', i);
            }
        });
    
    var maxSongDuration = d3.max(songs, function(d){
        return d.duration;
    });
    var durationScale = d3.scaleLinear().domain([0,maxSongDuration]).range([0,rectMaxWidth]);
        
    //duration rectangle
    listItems
        .append('rect')
        .attr('transform', function(d){
            return "translate("+rectLeftOffset+",-15)";
        })
        .attr('height', 20)
        .attr('width', function(d){
            return durationScale(d.duration);
        });
    
    //song name
    listItems
        .append('text')
        .attr('x', 20)
        .text(function(d){
            return d.audioFile;
        });
    
    //update playlist total duration
    var totalSeconds = d3.sum(songs, function(d){return d.duration});
        
    d3.select('#playlistDuration').text(d3.timeFormat('%-M:%S')(totalSeconds*1000));
    
}

function updateListItems(){
    listItems.selectAll('.play-stop-button')
        .text(getListItemButton);
}

function getListItemButton(d){
    if(d.playing){
        return "◼";
    }
    return "▶";
}
 
function preparePixelData(numPixels){
    var pixelData = [];
    d3.range(numPixels).forEach(function(el) {
        pixelData.push(0);
    });
    return pixelData;
}

function createCanvas(selector){
    
    //remove canvas if it already exists (like if server restarted while browser was open)
    d3.select(selector).select('canvas').remove();

    var canvas = d3.select(selector)
        .append('canvas')
        .attr('width', pixelTotalSize*pixelData.length)
        .attr('height', pixelSize);

    canvasContext = canvas.node().getContext('2d');
    
    var customBase = document.createElement('custom');
    canvasBase = d3.select(customBase); // this is our svg replacement
}

function bindPixelData(data) {
    
    var join = canvasBase.selectAll('custom.rect')
        .data(data);

    var enterSel = join.enter()
        .append('custom')
        .attr('class', 'rect')
          .attr('x', function(d, i) {
            return pixelTotalSize*i;
          })
          .attr('y', function(d, i) {
            return 0;
          })
                .attr('width', 0)
                .attr('height', 0);

    join
        .merge(enterSel)
        .attr('width', pixelSize)
        .attr('height', pixelTotalSize)
        .attr('fillStyle', function(d, i) {
            return '#'+decimalToHex(d);;
        });

}

function drawPixels() {
    // clear canvas
    canvasContext.fillStyle = '#222222';
    canvasContext.fillRect(0, 0, pixelTotalSize*pixelData.length, pixelTotalSize);

    // draw each individual custom element with their properties
    var elements = canvasBase.selectAll('custom.rect') // this is the same as the join variable, but used here to draw
                
    elements.each(function(d,i) {
        // for each virtual/custom element...
        var node = d3.select(this);
        canvasContext.fillStyle = node.attr('fillStyle');
        canvasContext.fillRect(node.attr('x'), node.attr('y'), node.attr('width'), node.attr('height'))
    });
}

function tick(){
    var message = '';
    var now = new Date();
    var untilNext = nextRuntime - now;
    if(untilNext >= 0){
        var totalSeconds = Math.round(untilNext/1000);
        var minutes = Math.floor(totalSeconds/60);
        if(minutes > 59){
            message = d3.timeFormat("%-I:%M %p")(nextRuntime);    
            setTimeout(tick, 10 * 60 * 1000);
        }else{
            var seconds = totalSeconds%60;
            var secondsPadding = '';
            if(seconds < 10){
                secondsPadding = "0";
            }
            message = minutes+":"+secondsPadding+seconds;
            setTimeout(tick, 1000);
        }
        d3.select('#clock-container').classed('hidden', false);
        document.querySelector('#clock').innerHTML = message;
    }else{
        document.querySelector('#clock').innerHTML = '';
        setTimeout(tick, 1000);
    }
}

function decimalToHex(d) {
  var hex = Number(d).toString(16);
  hex = "000000".substr(0, 6 - hex.length) + hex; 
  return hex;
}