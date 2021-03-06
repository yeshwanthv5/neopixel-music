/*TODO



use https://www.npmjs.com/package/omxplayer-controll
rewrite front end to handle receiving current song every payload


DONE
delayOffset option per song

startPixel offset
check if timeouts are running before cron starts playlist

fix bug with last pixel always black
offColor option per song
enforce minimum brightness/velocity to what light strip can display
RGB order option

fix bug cron fires every second during the minute it is triggered
offColor option
initialize all pixels to default color


COMMITED
merge track config into trackObjects
hide option
add velocityDarkensColor option to config?
validate if color config is valid colors d3.color(d) != null
*/

//default options
var config = {
    port: 8080,
    colorOrder: 'RGB',
    startPixel: 0,
    audioPath: '',
    cron: '0 * */1 * * *',
    delayBetweenSongs: 5000,
    offColor: 'pink',
    colors: ['red', 'green', 'purple'],
    pitchSort: 'ascending',
    minVelocity: 50, //ensures quiet notes still bright enough to illuminate pixel
    midiDelayX86: 100,
    midiDelayARM: 350
};

//override default options with config file
config = Object.assign(config, require('./config.js'));

//validate config file
//has songs
if(config.songs.length < 1){
    console.log('!!! Error !!!, no songs defined in config.js, config.songs is empty.');
    process.exit(0);
}

//d3
var d3 = require("d3");

//default colors
if(typeof config.colors == 'undefined' || config.colors.length == 0){
    var defaultColors = ['red', 'green', 'purple'];
    config.colors = defaultColors;
    console.log('Using default colors red, green and purple.  Override with array in config.colors using strings compatible with d3.color');
}

//colors are valid
config.colors.forEach((color, i)=>{
    var colorObject = d3.color(color);
    if(colorObject == null){
        console.log('config.color "'+color+'" is not a valid color.  Defaulting to white');
        config.colors.splice(i, 1, 'white');
    }
});

config.offColor = d3.color(config.offColor);

//set song specific off color
config.songs.forEach((song)=>{
    song.offColor = d3.color(song.offColor);
    if(!song.offColor){
        song.offColor = d3.color(config.offColor);
    }
});

//midi parser
var MidiPlayer = require('midi-player-js');
//mp3 player
var player = require('play-sound')(opts = {})
//neopixels
var ws281x = false;
if(process.arch == 'arm'){
    var ws281x = require('rpi-ws281x-native');
    var child_process = require('child_process');
}
const CronEmitter = require('cron-emitter');
var parser = require('cron-parser');

// Setup express server
var express = require('express');
var app = express();
var path = require('path');
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || config.port;

process.on('SIGINT', function () {
    //reset neopixels
    if(process.arch == 'arm'){
        ws281x.reset();
    }
    //terminate audio
    if(audioPlayer){
        audioPlayer.kill();
    }
    process.nextTick(function () { process.exit(0); });
});

http.listen(port, function(){
  //console.log('listening on *:'+port);
});

// Routing
app.use(express.static(path.join(__dirname, 'public')));

//state
var currentSong = config.songs.length - 1;
var schedulePlay = true;
var playMidiTimeout, nextSongTimeout;
var playMidiWaiting = false, nextSongWaiting = false;
var totalPixels = config.startPixel + config.numPixels;
var pixelData = new Uint32Array(config.startPixel + config.numPixels);

//init neopixels
if(process.arch == 'arm'){
    ws281x.init(pixelData.length, {dmaNum: 10}); //dmaNum 10 fixes read-only file system errors
    resetPixels();
}


var audioPlayer; //audio player
var midiParser = createMidiParser(); //midi parser
midiParser.on('fileLoaded', loadedSong);
midiParser.on('endOfFile', (event) => {
    io.emit('endOfFile', currentSong);
    console.log('endOfFile', currentSong, config.songs[currentSong].audioFile, new Date().toLocaleTimeString());

    config.songs[currentSong].playing = false;
    //play next song
    if(currentSong < config.songs.length - 1){
        console.log('currentSong', currentSong, 'over, play next song');
        nextSongTimeout = setTimeout(()=>{
            nextSongWaiting = false;
            playSong(currentSong+1);
        }, config.delayBetweenSongs);
        nextSongWaiting = true;
    }
});



var analyzedMidis = false;
loadSong(); //start loading each song, last to first and store track scale analyses

//cron schedule
const emitter = new CronEmitter();
emitter.add(config.cron, 'cron');
emitter.on('cron', () => {
    if(schedulePlay){
        var interval = parser.parseExpression(config.cron);
        io.emit('nextRuntime', interval.next());
        
        if(playMidiWaiting || nextSongWaiting){
            console.log('CRON suppressed, playMidiWaiting || nextSongWaiting', playMidiWaiting, nextSongWaiting, new Date().toLocaleTimeString()); 
        } else if(midiParser.isPlaying()){
            console.log('CRON suppressed, midi isPlaying()', new Date().toLocaleTimeString()); 
        }else{
            console.log('CRON run', new Date().toLocaleTimeString());
            //start playing first song, only if not already playing
            playSong(0);
        }
    }else{
        console.log('CRON suppressed, schedulePlay is false', new Date().toLocaleTimeString());
    }
});

function setupComplete(){
    console.log('Setup Complete');
    //web socket events
    io.on('connection', function (socket) {
    
        console.log('Client Connected');
        var interval = parser.parseExpression(config.cron);
        config.nextRuntime = new Date(interval.next());
        
        if(midiParser.isPlaying()){
            config.currentSong = currentSong;
        }
        
        socket.emit('config', config);
        socket.on('play', play);
        socket.on('stop', stop);
        socket.on('playSong', playSong);
        socket.on('disableSchedulePlay', disableSchedulePlay);
    });
}

function playSong(index){
    
    console.log('playSong('+index+')', new Date().toLocaleTimeString());
    
    if(currentSong != index){
        //new song, change song and play
        stop();
        console.log('set currentSong to', index);
        currentSong = index;
        isPlaybackReady = false;
        loadSong();
    }else{
        //same song, restart
        stop();
        play();
    }
}

function loadSong(){
    midiParser.loadFile(config.audioPath+config.songs[currentSong].midiFile);
}

function loadedSong(midiParser){
    //analyze midi tracks, recursively load next song in reverse order so first song is ready to play
    if(!analyzedMidis){
        config.songs[currentSong].duration = midiParser.getSongTime();
        console.log('Analyze song', currentSong, config.songs[currentSong].midiFile, Math.round(config.songs[currentSong].duration)+' seconds');        
        analyzeMidi(midiParser, currentSong);
        if(currentSong > 0){
            //analyze the rest of the songs
            loadSong(--currentSong);
        }else{
            analyzedMidis = true;
            setupComplete();
            playbackReady();
        }
    }else{
        console.log('Loaded song', currentSong, config.songs[currentSong].midiFile, Math.round(midiParser.getSongTime())+' seconds', new Date().toLocaleTimeString());
        playbackReady();
        play();
    }
}

function playbackReady(){
    isPlaybackReady = true;
}

function disableSchedulePlay(){
    schedulePlay = false;
    playMidiTimeout && clearTimeout(playMidiTimeout);
    nextSongTimeout && clearTimeout(nextSongTimeout);
}

// Initialize player and register event handler
function createMidiParser(){
    return new MidiPlayer.Player(function(event) {
        if(event.name == "Note off" || event.name == "Note on"){

            var song = config.songs[currentSong];
            var trackObject = song.trackObjects[song.originalTrackOrder[event.track-1]];

            if(!trackObject.hide){
                var startPixel = trackObject.scale(event.noteNumber);
                if(song.tracksUseFullWidth){
                    var endPixel = startPixel+trackObject.segmentSize;
                }else{
                    var endPixel = startPixel+Math.round(song.segmentSize);
                }
     
                var color = song.offColor;

                if(event.name == "Note on" && event.velocity > 0){
                    var volume = trackObject.volumeScale(event.velocity);
                    if(volume < config.minVelocity) volume = config.minVelocity; //enforce minimum brightness
                    color = trackObject.color.darker((100-volume)/10); //darken color based on note volume
                }
                
                setPixels(startPixel, endPixel, color);
            }
        } 
    });
}

function setPixels(startPixel, endPixel, color){

    for(var x = startPixel; x < endPixel; x++){
        pixelData[x] = colorObjectToInt(color);
    }
    
    var percentRemaining = 100;
    if(typeof midiParser != 'undefined'){
        percentRemaining = midiParser.getSongPercentRemaining()
    }
    
    io.emit('pixelData', {
        pixelData:Array.from(pixelData),
        currentSong: currentSong,
        percentRemaining: percentRemaining
    });
    if(process.arch == 'arm'){
        ws281x.render(pixelData);
    }
}

function play(){

    if(!isPlaybackReady){
        console.log('!!!! PLAYBACK NOT READY !!!!');
        return;
    }

    var delay = config.midiDelayX86;
    if(process.arch == 'arm'){
        delay = config.midiDelayARM;
    }
    
    var songDelay = parseInt(config.songs[currentSong].delay);
    if(!isNaN(songDelay)){
        delay += songDelay;
    }
    if(delay < 0){
        delay = 0;
    }
    
    playMidiTimeout = setTimeout(function(){
        config.songs[currentSong].midiStartAt && midiParser.skipToSeconds(config.songs[currentSong].midiStartAt);
        if(typeof config.songs[currentSong].midiTempo != 'undefined'){
            midiParser.tempo = config.songs[currentSong].midiTempo;
        }
        try{
            midiParser.play();
        }catch(e){
            console.log('ERROR Unable to play midi '+ config.songs[currentSong]+', already playing.', new Date().toLocaleTimeString());
        }
        playMidiWaiting = false;
        
        //reenable schedule play and notify front end
        schedulePlay = true;
        var interval = parser.parseExpression(config.cron);
        io.emit('nextRuntime', interval.next());
    }, delay);
    playMidiWaiting = true;
    
    
    //range from 0 to -6000 millibels
    var omxVolumeScale = d3.scaleLinear().range([-6000, 0]).clamp(true);
    var volume = omxVolumeScale(1);
    if(!isNaN(config.songs[currentSong].volume)){
        volume = omxVolumeScale(config.songs[currentSong].volume);
    }
    
    audioPlayer = player.play(config.audioPath+config.songs[currentSong].audioFile, { omxplayer: ['-o', 'alsa', '--vol', volume ]}, function(err){
      //if (err && !err.killed) throw err
    });
    
    console.log('Play audio', config.songs[currentSong].audioFile, new Date().toLocaleTimeString());
    io.emit('play', currentSong);
    config.songs[currentSong].playing = true; 
    
    //set pixels
    setPixels(config.startPixel, config.startPixel+config.numPixels, config.songs[currentSong].offColor);
}

function stop(){
    console.log('stop()', new Date().toLocaleTimeString());
    
    playMidiTimeout && clearTimeout(playMidiTimeout);
    nextSongTimeout && clearTimeout(nextSongTimeout);

    midiParser.stop();
    midiParser.skipToTick(0);
    
    
    if(process.arch == 'arm'){
        child_process.exec('kill $(pgrep omxplayer)');
    }
    if(audioPlayer){
        audioPlayer.kill();
    }
    resetPixels();
    console.log('Stop');
    io.emit('stop', currentSong);
    config.songs[currentSong].playing = false;
}

function resetPixels(){
    setPixels(config.startPixel, config.startPixel+config.numPixels, config.offColor); //set all pixels black/off
}

function analyzeMidi(player, songIndex){

    var song = config.songs[songIndex];
    var trackNests = [];
    var trackNotes = [];
    
    //create config tracks array
    var tracks = [];
        
    //group all notes by track
    player.tracks.forEach(function(track){
        trackNests.push(d3.nest()
            .key(function(d) { return d.name; })
            .key(function(d) { return d.noteNumber; }).sortKeys((a, b)=>{
                var numA = parseInt(a);
                var numB = parseInt(b);
                return numA - numB;
            })
            .entries(track.events))
    });
        
    //store which notes each track contains
    trackNests.forEach((trackNest, i)=>{
        
        trackNotes[i] = [];
        
        var instrument = '';
        var maxVelocity = 0;
        
        trackNest.forEach((event)=>{
            if(event.key == "Note on"){
                event.values.forEach((noteNumber)=>{
                    var noteMaxVelocity = d3.max(noteNumber.values, (d)=>{ return d.velocity});
                    maxVelocity = (noteMaxVelocity > maxVelocity) ? noteMaxVelocity : maxVelocity;
                    trackNotes[i].push(parseInt(noteNumber.key));
                });
            }else if(event.key == "Sequence/Track Name"){
                var trackNameEvent = event.values[0].values[0];
                //store track instrument in config
                instrument = trackNameEvent.string.trim();
            }
        });
        
        //create track object
        tracks.push({
            name: 'Track'+(i+1),
            index: i, //retain original index which will be resorted by median pitch later so that midi events can be matched up to trackObject
            instrument: instrument,
            maxVelocity: maxVelocity,
            volumeScale: d3.scaleLinear().range([0,100]).domain([0,maxVelocity])
        });
    });
    
    //calculate track stats
    trackNotes.forEach((notes, i)=>{
        tracks[i].medianPitch = (notes.length) ? d3.median(notes) : 0; //median pitch
        tracks[i].notes = notes;
    });
        
    //sort tracks by pitch so higher pitch notes show up at end of pixel strip and lower notes show up at other end of pixel strip
    var sortDirection = (config.pitchSort) ? d3[config.pitchSort] : d3.ascending;
    tracks.sort((a,b)=>{
        return sortDirection(a.medianPitch, b.medianPitch);
    });
    song.originalTrackOrder = [];

    //merge in trackOptions from config file
    if(typeof song.trackOptions != 'undefined'){
        song.trackOptions.forEach((trackOptions)=>{
            var found = false;
            tracks.forEach((track)=>{
                if(trackOptions.name == track.name){                                   
                    if(typeof trackOptions.color != 'undefined'){
                        var colorObject = d3.color(trackOptions.color);
                        if(colorObject != null){
                            track.color = colorObject;
                        }else{
                            console.log('Config track "'+trackOptions.name+'" for "'+song.midiFile+'" has invalid color: "'+trackOptions.color+'".');
                        }
                    }

                    if(trackOptions.hide){
                        track.hide = true;
                    }
                    found = true;
                }
            });
            if(!found){
                console.log('Config track "'+trackOptions.name+'" not found for "'+song.midiFile+'".  Change config trackOptions names to one of these tracks with notes:');
                tracks.forEach((track)=>{
                    if(track.notes.length)
                        console.log('    "'+track.name+'" has '+track.notes.length+' notes. Median pitch '+track.medianPitch+'. Instrument: "'+track.instrument+'".');
                });
            }
        });
    }
    
    song.totalNotes = 0;
    tracks.forEach((track)=>{
        if(!track.hide){
            song.totalNotes += track.notes.length;
        }
    });
    
    //calculate pixel width of each note
    var rawSegmentSize, segmentSize;
    if(song.tracksUseFullWidth){
        //PIXELS CAN OVERLAP IF MULTIPLE TRACKS PLAY NOTES SIMULTANEOUSLY
        //tracks with few notes have very wide pixel segments, tracks with many notes have narrow segments
    }else{
        //tracks are separated into lanes, guaranteed not to overlap.  all notes have same segment size
        song.rawSegmentSize = config.numPixels/song.totalNotes; //tracks separated into "lanes" of pixels
        song.segmentSize = Math.floor(song.rawSegmentSize);
        if(song.segmentSize < 1){
            song.segmentSize = 1;
        }
    }
    
    var pixelIndex = config.startPixel;    
    var colorIndex = 0;
    song.trackObjects = tracks;
    
    //assign track color and pixel range
    song.trackObjects.forEach((trackObject, i)=>{    
        var notes = trackObject.notes;        
        trackObject.numNotes = notes.length;

        //store original track order from before sorting
        song.originalTrackOrder[trackObject.index] = i;
        
        //if track has notes, assign next color in config.colors, unless trackOption color already specified or track hide=true
        if(trackObject.numNotes && !trackObject.color && !trackObject.hide){
            trackObject.color = d3.color(d3.scaleOrdinal().range(config.colors).domain(d3.range(config.colors.length))(colorIndex++%config.colors.length));
        }

        var range = [];
        
        if(song.tracksUseFullWidth){
            rawSegmentSize = config.numPixels/notes.length;
            segmentSize = Math.floor(rawSegmentSize);
            trackObject.segmentSize = segmentSize;
            range = d3.range(config.startPixel, config.startPixel+config.numPixels, rawSegmentSize).map((d)=>{ return Math.round(d)});
        }else if(!trackObject.hide){

            while(range.length < notes.length){
                var pixel = Math.round((pixelIndex-config.startPixel)*song.rawSegmentSize)+config.startPixel;
                range.push(pixel);
                pixelIndex++;
            }
        }
        
        if(config.pitchSort == 'descending'){
            range.reverse();
        }
        
        trackObject.scale = d3.scaleOrdinal(range).domain(notes);
        trackObject.range = trackObject.scale.range();
        trackObject.domain = trackObject.scale.domain();
        
    });  
}

function colorObjectToInt(colorObject){
    return rgb2Int(colorObject[config.colorOrder[0].toLowerCase()],colorObject[config.colorOrder[1].toLowerCase()],colorObject[config.colorOrder[2].toLowerCase()]);
}

function rgb2Int(r, g, b) {
  return ((r & 0xff) << 16) + ((g & 0xff) << 8) + (b & 0xff);
}