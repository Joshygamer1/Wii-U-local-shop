
/* SHARED NINTENDO ESHOP MUSIC PLAYER
   Wii U-compatible autoplay attempt
*/

(function () {

    var MUSIC_FILE = "assets/eshop/eshop-music.mp3";
    var STATE_KEY = "eshopMusicPlaying";
    var TIME_KEY = "eshopMusicPosition";

    var music = document.createElement("audio");
    music.loop = true;
    music.preload = "auto";

    var source = document.createElement("source");
    source.src = MUSIC_FILE;
    source.type = "audio/mpeg";
    music.appendChild(source);

    var player = document.createElement("div");
    player.className = "music-player";

    var button = document.createElement("button");
    button.id = "musicButton";
    button.type = "button";

    player.appendChild(button);
    player.appendChild(music);
    document.body.appendChild(player);

    function getStorage(key, fallback) {
        try {
            var value = sessionStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (error) {
            return fallback;
        }
    }

    function setStorage(key, value) {
        try {
            sessionStorage.setItem(key, value);
        } catch (error) {}
    }

    var savedPosition = parseFloat(getStorage(TIME_KEY, "0"));

    if (isNaN(savedPosition)) {
        savedPosition = 0;
    }

    function updateButton() {
        button.innerHTML = music.paused
            ? "♫ Music: OFF"
            : "♫ Music: ON";
    }

    function savePosition() {
        try {
            setStorage(TIME_KEY, String(music.currentTime));
        } catch (error) {}
    }

    function playMusic() {
        try {
            var result = music.play();

            if (result && typeof result.then === "function") {
                result.then(function () {
                    setStorage(STATE_KEY, "true");
                    updateButton();
                }, function () {
                    setStorage(STATE_KEY, "false");
                    updateButton();
                });
            } else {
                setStorage(STATE_KEY, "true");
                updateButton();
            }

        } catch (error) {
            setStorage(STATE_KEY, "false");
            updateButton();
        }
    }

    button.onclick = function () {
        if (music.paused) {
            playMusic();
        } else {
            music.pause();
            setStorage(STATE_KEY, "false");
            savePosition();
            updateButton();
        }
    };

    music.onloadedmetadata = function () {

        if (savedPosition > 0 && savedPosition < music.duration) {
            try {
                music.currentTime = savedPosition;
            } catch (error) {}
        }

        // Automatically attempt to start the music.
        playMusic();
    };

    music.ontimeupdate = savePosition;

    music.onplay = updateButton;
    music.onpause = updateButton;

    music.onerror = function () {
        button.innerHTML = "♫ Music unavailable";
    };

    window.onpagehide = savePosition;
    window.onunload = savePosition;

    updateButton();

})();
