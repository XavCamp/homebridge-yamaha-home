const debug = require('debug')('yamaha-home');
const Yamaha = require('yamaha-nodejs');
const Q = require('q');
const bonjour = require('bonjour')();
const ip = require('ip');

/**
 * @typedef {Object} ConfigObject
 * @property {string} zone
 * @property {number|undefined} play_volume
 * @property {number} min_volume
 * @property {number} max_volume
 * @property {boolean} show_input_name
 * @property {string} setMainInputTo
 * @property {number} expected_devices
 * @property {number} discovery_timeout
 * @property {boolean} radio_presets
 * @property {boolean} preset_num
 * @property {Object} manual_addresses
 * @property {boolean} spotify
 * @property {boolean} party_switch
 * @property {boolean} pure_direct_switch
 * @property {Object} inputs_as_accessories
 * @property {string[]} zone_controllers_only_for
 */


module.exports = function (homebridge) {
  const sysIds = {};
  const accessories = [];

  const Service = homebridge.hap.Service;
  const Characteristic = homebridge.hap.Characteristic;

  class YamahaAVRPlatform {
    /**
     *
     * @param {Function} log
     * @param {ConfigObject} config
     */
    constructor(log, config) {
      this.log = log;
      this.service = Service;
      this.characteristic = Characteristic;
      this.config = config;
      this.zone = config.zone || "Main";
      this.playVolume = config.play_volume;
      this.minVolume = config.min_volume || -65.0;
      this.maxVolume = config.max_volume || -10.0;
      this.gapVolume = this.maxVolume - this.minVolume;
      this.setMainInputTo = config.setMainInputTo;
      this.expectedDevices = config.expected_devices || 100;
      this.discoveryTimeout = config.discovery_timeout || 10;
      this.radioPresets = config.radio_presets;
      this.presetNum = config.preset_num;
      this.manualAddresses = config.manual_addresses || {};
      this.spotifyControls = config.spotify;
      this.partySwitch = config.party_switch;
      this.pureDirectSwitch = config.pure_direct_switch;
      this.muteSwitch = config.mute_switch;
      this.inputAccessories = config.inputs_as_accessories || {};
      this.zoneControllersOnlyFor = config.zone_controllers_only_for || null;
    }

    // Custom Characteristics and service...

    Input() {
      this.characteristic.call(this, 'Input', '00001003-0000-1000-8000-135D67EC4377');
      this.setProps({
        format: this.characteristic.Formats.STRING,
        perms: [this.characteristic.Perms.READ, this.characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }


    InputName() {
      this.characteristic.call(this, 'Input Name', '00001004-0000-1000-8000-135D67EC4377');
      this.setProps({
        format: this.characteristic.Formats.STRING,
        perms: [this.characteristic.Perms.READ, this.characteristic.Perms.NOTIFY]
      });
      this.value = this.getDefaultValue();
    }


    InputService(displayName, subtype) {
      this.service.call(this, displayName, '00000002-0000-1000-8000-135D67EC4377', subtype);

      // Required Characteristics
      this.addCharacteristic(YamahaAVRPlatform.Input);

      // Optional Characteristics
      this.addOptionalCharacteristic(YamahaAVRPlatform.InputName);
    }


    accessories(callback) {
      this.log("Getting Yamaha AVR devices.");

      const browser = bonjour.find({
        type: 'http'
      }, bonjourService => this._setupFromService(bonjourService));

      let timer, timeElapsed = 0,
        checkCyclePeriod = 5000;

      // process manually specified devices...
      for (let key in this.manualAddresses) {
        if (!this.manualAddresses.hasOwnProperty(key)) continue;
        debug("THIS-0", this);
        this._setupFromService({
          name: key,
          host: this.manualAddresses[key],
          port: 80
        });
      };

      // The callback can only be called once...so we'll have to find as many as we can
      // in a fixed time and then call them in.
      const timeoutFunction = () => {
        if (accessories.length >= this.expectedDevices) {
          clearTimeout(timer);
        } else {
          timeElapsed += checkCyclePeriod;
          if (timeElapsed > this.discoveryTimeout * 1000) {
            this.log("Waited " + this.discoveryTimeout + " seconds, stopping discovery.");
          } else {
            timer = setTimeout(timeoutFunction, checkCyclePeriod);
            return;
          }
        }
        browser.stop();
        this.log("Discovery finished, found " + accessories.length + " Yamaha AVR devices.");
        callback(accessories);
      };
      timer = setTimeout(timeoutFunction, checkCyclePeriod);
    }

    /**
     * @param {bonjour.Service} bonjourService
     */
    _setupFromService(bonjourService) {
      // Looking for name, host and port
      this.log("Possible Yamaha device discovered", bonjourService.name, bonjourService.addresses);
      if (bonjourService.addresses) {
        for (let address of bonjourService.addresses) {
          if (ip.isV4Format(address)) {
            bonjourService.host = address;
            break;
          }
        }
      }

      var name = bonjourService.name;
      //console.log('Found HTTP bonjourService "' + name + '"');
      // We can't tell just from mdns if this is an AVR...
      if (bonjourService.port != 80) return; // yamaha-nodejs assumes this, so finding one on another port wouldn't do any good anyway.
      var yamaha = new Yamaha(bonjourService.host);
      yamaha.getSystemConfig().then(
        function (sysConfig) {
          //  debug( JSON.stringify(sysConfig, null, 2));
          if (sysConfig && sysConfig.YAMAHA_AV) {
            var sysModel = sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0];
            var sysId = sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0];
            if (sysIds[sysId]) {
              this.log("WARN: Got multiple systems with ID " + sysId + "! Omitting duplicate!");
              return;
            }
            sysIds[sysId] = true;
            this.log("Found Yamaha " + sysModel + " - " + sysId + ", \"" + name + "\"");

            // Conditional statement. If we have any inputs in config.json property "inputs_as_accessories" this will create those switches.
            // Functionality added via YamahaInputService contructor function
            if (this.inputAccessories.hasOwnProperty("YamahaReceiver")) {
              for (var key in this.inputAccessories) {
                var inputs = this.inputAccessories[key];
                for (var inputKey in inputs) {
                  var inputConfig = inputs[inputKey];
                  var input = parseInt(inputKey);
                  var accname = inputConfig.name;
                  this.log.info("Making accessory \"" + accname + "\" for input " + input);
                  var accessory = new YamahaInputService(this.log, inputConfig, accname, yamaha, sysConfig, input);
                  accessories.push(accessory);
                  if (accessories.length >= this.expectedDevices)
                    timeoutFunction(); // We're done, call the timeout function now.
                }
              }
            }

            //Adding accessory with YamahaParty Switch.
            if (this.partySwitch) {
              accessories.push(new YamahaParty(this.log, this.config, name, yamaha, sysConfig));
            }

            //Adding accessory with Yamaha Pure Direct.
            if (this.pureDirectSwitch) {
              accessories.push(new YamahaPureDirect(this.log, name, yamaha, sysConfig, this.service, this.characteristic));
            }

            //Adding accessory with Mute switch.
            if (this.muteSwitch) {
              accessories.push(new YamahaMute(this.log, name, yamaha, sysConfig, this.service, this.characteristic));
            }

            if (this.spotifyControls) {
              const buttons = ["Play", "Pause", "Skip Fwd", "Skip Rev"];
              for (let i = 0, len = buttons.length; i < len; i++) {
                accessories.push(new YamahaSpotify(this.log, this.config, buttons[i], yamaha, sysConfig));
              }
            }


            yamaha.getAvailableZones().then(
              function (zones) {
                // Only add zones control if more than 1 zone
                // Hack to always create a zone control
                // TODO: Remove if block
                if (zones.length > 0) {
                  // for (var zone in zones) {
                  var zone = zones[0];
                  yamaha.getBasicInfo(zones[zone]).then(function (basicInfo) {
                    if (basicInfo.getVolume() != -999) {

                      yamaha.getZoneConfig(basicInfo.getZone()).then(
                        function (zoneInfo) {
                          var z = Object.keys(zoneInfo.YAMAHA_AV)[1];
                          const zoneName = zoneInfo.YAMAHA_AV[z][0].Config[0].Name[0].Zone[0];
                          if (this.zoneControllersOnlyFor == null || this.zoneControllersOnlyFor.includes(zoneName)) {
                            this.log("Adding zone controller for", zoneName);
                            var accessory = new YamahaZone(this.log, this.config, zoneName, yamaha, sysConfig, z);
                            accessories.push(accessory);
                          }
                        }.bind(this)
                      );

                    }
                  }.bind(this));

                  // }
                }
              }.bind(this)
            );

            // Add buttons for each preset

            if (this.radioPresets) {
              yamaha.getTunerPresetList().then(function (presets) {
                for (var preset in presets) {
                  this.log("Adding preset %s - %s", preset, presets[preset].value, this.presetNum);
                  if (!this.presetNum) {
                    // preset by frequency
                    var accessory = new YamahaSwitch(this.log, this.config, presets[preset].value, yamaha, sysConfig, preset);
                  } else {
                    // Preset by number
                    var accessory = new YamahaSwitch(this.log, this.config, preset, yamaha, sysConfig, preset);
                  }
                  accessories.push(accessory);
                };
              }.bind(this));
            }
          }
          if (accessories.length >= this.expectedDevices)
            timeoutFunction(); // We're done, call the timeout function now.
        }.bind(this),
        function (error) {
          this.log("DEBUG: Failed getSystemConfig from " + name + ", probably just not a Yamaha AVR.");
        }.bind(this)
      );
    }
  }

  //Pure Direct Switch
  class YamahaPureDirect {
    constructor(log, name, yamaha, sysConfig, service, characteristic) {
      this.log = log;
      this.yamaha = yamaha;
      this.sysConfig = sysConfig;
      this.service = service;
      this.characteristic = characteristic;

      this.name = "Pure Direct";

      this.log("Adding Pure Direct %s", name);
    }

    getServices() {
      var informationService = new this.service.AccessoryInformation();

      informationService
        .setCharacteristic(this.characteristic.Name, this.name)
        .setCharacteristic(this.characteristic.Manufacturer, "yamaha-home")
        .setCharacteristic(this.characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
        .setCharacteristic(this.characteristic.FirmwareRevision, require('./package.json').version)
        .setCharacteristic(this.characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);

      var pureDirectService = new this.service.Switch(this.name);
      pureDirectService.getCharacteristic(this.characteristic.On)
        .on('get', callback => this.yamaha.isPureDirectEnabled().then(result => callback(null, result)))
        .on('set', (on, callback) => this.yamaha.setPureDirect(on).then(() => callback(null, on)));
      return [informationService, pureDirectService];
    }
  };

  //Mute Switch
  class YamahaMute {
    constructor(log, name, yamaha, sysConfig, service, characteristic) {
      this.log = log;
      this.yamaha = yamaha;
      this.sysConfig = sysConfig;
      this.service = service;
      this.characteristic = characteristic;

      this.name = "Mute";

      this.log("Adding Mute %s", name);
    }

    getServices() {
      var informationService = new this.service.AccessoryInformation();

      informationService
        .setCharacteristic(this.characteristic.Name, this.name)
        .setCharacteristic(this.characteristic.Manufacturer, "yamaha-home")
        .setCharacteristic(this.characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
        .setCharacteristic(this.characteristic.FirmwareRevision, require('./package.json').version)
        .setCharacteristic(this.characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);

      var pureDirectService = new this.service.Switch(this.name);
      pureDirectService.getCharacteristic(this.characteristic.On)
        .on('get', callback => this.yamaha.isMuted().then(result => callback(null, result)))
        .on('set', (on, callback) => (on ? this.yamaha.muteOn() : this.yamaha.muteOff()).then(() => callback(null, on)));
      return [informationService, pureDirectService];
    }
  };

  //Party Mode Switch
  function YamahaParty(log, config, name, yamaha, sysConfig) {
    this.log = log;
    this.config = config;
    this.yamaha = yamaha;
    this.sysConfig = sysConfig;

    this.nameSuffix = config.name_suffix || " Party Mode";
    this.zone = config.zone || 1;
    this.name = "Party Mode";
    this.serviceName = name;
    this.setMainInputTo = config.setMainInputTo;
    this.playVolume = this.config.play_volume;
    this.minVolume = config.min_volume || -65.0;
    this.maxVolume = config.max_volume || -10.0;
    this.gapVolume = this.maxVolume - this.minVolume

    this.log("Adding Party Switch %s", name);
  }

  YamahaParty.prototype = {

    getServices: function () {
      var that = this;
      var informationService = new Service.AccessoryInformation();
      var yamaha = this.yamaha;

      informationService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "yamaha-home")
        .setCharacteristic(Characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
        .setCharacteristic(Characteristic.FirmwareRevision, require('./package.json').version)
        .setCharacteristic(Characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);

      var partyService = new Service.Switch(this.name);
      partyService.getCharacteristic(Characteristic.On)
        .on('get', function (callback) {
          const that = this;
          this.yamaha.isPartyModeEnabled().then(function (result) {
            callback(null, result);
          });
        }.bind(this))
        .on('set', function (on, callback) {
          if (on) {
            const that = this;
            this.yamaha.powerOn().then(function () {
              that.yamaha.partyModeOn().then(function () {
                callback(null, true);
              });
            });
          } else {
            this.yamaha.partyModeOff().then(function () {
              callback(null, false);
            });
          }
        }.bind(this));
      return [informationService, partyService];
    }
  };

  //Party Mode Switch
  function YamahaSpotify(log, config, name, yamaha, sysConfig) {
    this.log = log;
    this.config = config;
    this.yamaha = yamaha;
    this.sysConfig = sysConfig;

    this.nameSuffix = config.name_suffix || " Party Mode";
    this.zone = config.zone || 1;
    this.name = "Spotify " + name;
    this.serviceName = name;
    this.setMainInputTo = config.setMainInputTo;
    this.playVolume = this.config.play_volume;
    this.minVolume = config.min_volume || -65.0;
    this.maxVolume = config.max_volume || -10.0;
    this.gapVolume = this.maxVolume - this.minVolume

    this.log("Adding spotify button %s", name);
  }

  YamahaSpotify.prototype = {

    getServices: function () {
      var informationService = new Service.AccessoryInformation();
      var yamaha = this.yamaha;

      informationService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "yamaha-home")
        .setCharacteristic(Characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
        .setCharacteristic(Characteristic.FirmwareRevision, require('./package.json').version)
        .setCharacteristic(Characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);

      var spotifyButton = new Service.Switch(this.name);
      this.spotifyButton = spotifyButton;
      spotifyButton.getCharacteristic(Characteristic.On)
        .on('set', function (on, callback) {
          debug("Spotify Control", this.serviceName);
          if (on) { // <YAMAHA_AV cmd="PUT"><Spotify><Play_Control><Playback>Play                </Playback></Play_Control></Spotify></YAMAHA_AV>
            this.yamaha.SendXMLToReceiver('<YAMAHA_AV cmd="PUT"><Spotify><Play_Control><Playback>' + this.serviceName + '</Playback></Play_Control></Spotify></YAMAHA_AV>');
            setTimeout(function () {
              this.spotifyButton.setCharacteristic(Characteristic.On, 0);
            }.bind(this), 1 * 1000); // After 1 second turn off
          }
          callback(null, on);
        }.bind(this));

      return [informationService, spotifyButton];
    }
  };

  // Inputs or Scenes as additional Switches.

  function YamahaInputService(log, config, name, yamaha, sysConfig) {
    this.log = log;
    this.config = config;
    this.yamaha = yamaha;
    this.sysConfig = sysConfig;

    this.nameSuffix = config.name_suffix || " Party Mode";
    this.zone = config.zone || 1;
    this.name = name;
    this.setDefaultVolume = config.set_default_volume;
    this.serviceName = name;
    this.defaultServiceName = config.default_service_name;
    this.defaultServiceName = this.serviceName
    this.setMainInputTo = config.setMainInputTo;
    this.playVolume = this.config.play_volume;
    this.minVolume = config.min_volume || -65.0;
    this.maxVolume = config.max_volume || -10.0;
    this.gapVolume = this.maxVolume - this.minVolume

    this.setInputTo = config.setInputTo || config.setMainInputTo;
    this.setScene = config.set_scene || {}; //Scene Feature
    this.log("Adding Input Switch %s", name);
  }

  //Prototype function runs for each switch specified in config json file. Loop syntax is in function _setupFromService(service). Currently line 189.
  YamahaInputService.prototype = {

    getServices: function () {
      var that = this;
      var informationService = new Service.AccessoryInformation();
      var yamaha = this.yamaha;

      informationService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "yamaha-home")
        .setCharacteristic(Characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
        .setCharacteristic(Characteristic.FirmwareRevision, require('./package.json').version)
        .setCharacteristic(Characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);

      var inputSwitchService = new Service.Switch(this.name);
      this.inputSwitchService = inputSwitchService;
      inputSwitchService.getCharacteristic(Characteristic.On)
        .on('get', function (callback, context) {
          this.yamaha.getCurrentInput().then(
            function (result) {
              // that.log(result) //This logs the current Input. Needed for testing.
              // Conditional statement below checks the current input. If input 1 is active, all other inputs in Home App become not active.
              // When swithing input from 1 to 3, input 3 becomes active and input 1 becomes not active. (input numbers are for example)
              if (result !== that.setInputTo) {
                //that.log("Current Input: " + result + "!== to Button input:" + that.setInputTo). Needed for testing.
                callback(null, false);
              } else if (result === that.setInputTo) {
                callback(null, true);
                //that.log("Current Input: " + result + "=== to Button input:" + that.setInputTo). Needed for testing.
              }
            }
          )
        }.bind(this))
        .on('set', function (on, callback) {
          if (on) {
            var that = this;
            this.yamaha.powerOn().then(function () {
              that.yamaha.setMainInputTo(that.setInputTo).then(function () { //If set_scene exists, this will set the scene
                //This will set the scene
                that.yamaha.SendXMLToReceiver('<YAMAHA_AV cmd="PUT"><Main_Zone><Scene><Scene_Sel>Scene ' + that.setScene + '</Scene_Sel></Scene></Main_Zone></YAMAHA_AV>').then(function () {
                  //This will set the input
                  that.yamaha.setVolumeTo(that.setDefaultVolume * 10, this.zone).then(function () {
                    callback(null, true);
                  });
                });
              });
            });
          } else {
            callback(null, false);
          }
          setTimeout(function () {
            this.inputSwitchService.setCharacteristic(Characteristic.On, 0);
          }.bind(this), 1 * 1000); // After 1 second turn off
        }.bind(this));

      return [informationService, inputSwitchService];
    }
  };

  function YamahaSwitch(log, config, name, yamaha, sysConfig, preset) {
    this.log = log;
    this.config = config;
    this.yamaha = yamaha;
    this.sysConfig = sysConfig;

    this.nameSuffix = config.name_suffix || " Speakers";
    this.zone = config.zone || 1;
    this.name = 'Preset ' + parseInt(name).toString();
    this.serviceName = name + this.nameSuffix;
    this.setMainInputTo = config.setMainInputTo;
    this.playVolume = this.config.play_volume;
    this.minVolume = config.min_volume || -65.0;
    this.maxVolume = config.max_volume || -10.0;
    this.gapVolume = this.maxVolume - this.minVolume
    this.preset = preset;
  }

  YamahaSwitch.prototype = {

    getServices: function () {
      var that = this;
      var informationService = new Service.AccessoryInformation();
      var yamaha = this.yamaha;

      informationService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "yamaha-home")
        .setCharacteristic(Characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
        .setCharacteristic(Characteristic.FirmwareRevision, require('./package.json').version)
        .setCharacteristic(Characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);

      var switchService = new Service.Switch(this.name);
      switchService.getCharacteristic(Characteristic.On)
        .on('get', function (callback, context) {
          yamaha.getBasicInfo().then(function (basicInfo) {
            debug('Is On', basicInfo.isOn()); // True
            debug('Input', basicInfo.getCurrentInput()); // Tuner

            if (basicInfo.isOn() && basicInfo.getCurrentInput() == 'TUNER') {

              yamaha.getTunerInfo().then(function (result) {
                //console.log( 'TunerInfo', JSON.stringify(result,null, 0));
                debug(result.Play_Info[0].Feature_Availability[0]); // Ready
                debug(result.Play_Info[0].Search_Mode[0]); // Preset
                debug(result.Play_Info[0].Preset[0].Preset_Sel[0]); // #
                if (result.Play_Info[0].Feature_Availability[0] == 'Ready' &&
                  result.Play_Info[0].Search_Mode[0] == 'Preset' &&
                  result.Play_Info[0].Preset[0].Preset_Sel[0] == this.preset) {
                  callback(false, true);
                } else {
                  callback(false, false);
                }
              }.bind(this));

            } else {
              // Off
              callback(false, false);
            }

          }.bind(this), function (error) {
            callback(error);
          });

        }.bind(this))
        .on('set', function (powerOn, callback) {
          yamaha.setMainInputTo("TUNER").then(function () {
            return yamaha.selectTunerPreset(this.preset).then(function () {
              this.log('Tuning radio to preset %s - %s', this.preset, this.name);
              callback(null, 1);
            }.bind(this));
          }.bind(this));

        }.bind(this));

      return [informationService, switchService];
    }
  };

  function YamahaZone(log, config, name, yamaha, sysConfig, zone) {
    this.log = log;
    this.config = config;
    this.yamaha = yamaha;
    this.sysConfig = sysConfig;

    this.minVolume = config.min_volume || -65.0;
    this.maxVolume = config.max_volume || -10.0;
    this.gapVolume = this.maxVolume - this.minVolume;

    this.zone = zone;
    this.name = name;
  }

  YamahaZone.prototype = {

    setPlaying: function (playing) {
      var that = this;
      var yamaha = this.yamaha;

      if (playing) {

        return yamaha.powerOn(that.zone).then(function () {
          if (that.playVolume) return yamaha.setVolumeTo(that.playVolume * 10, that.zone);
          else return Q();
        }).then(function () {
          if (that.setMainInputTo) return yamaha.setMainInputTo(that.setMainInputTo);
          else return Q();
        }).then(function () {
          if (that.setMainInputTo == "AirPlay") return yamaha.SendXMLToReceiver(
            '<YAMAHA_AV cmd="PUT"><AirPlay><Play_Control><Playback>Play</Playback></Play_Control></AirPlay></YAMAHA_AV>'
          );
          else return Q();
        });
      } else {
        return yamaha.powerOff(that.zone);
      }
    },

    getServices: function () {
      var that = this;
      var informationService = new Service.AccessoryInformation();
      var yamaha = this.yamaha;

      informationService
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, "yamaha-home")
        .setCharacteristic(Characteristic.Model, this.sysConfig.YAMAHA_AV.System[0].Config[0].Model_Name[0])
        .setCharacteristic(Characteristic.FirmwareRevision, require('./package.json').version)
        .setCharacteristic(Characteristic.SerialNumber, this.sysConfig.YAMAHA_AV.System[0].Config[0].System_ID[0]);

      var zoneService = new Service.Lightbulb(this.name);
      zoneService.getCharacteristic(Characteristic.On)
        .on('get', function (callback, context) {
          yamaha.isOn(that.zone).then(
            function (result) {
              callback(false, result);
            }.bind(this),
            function (error) {
              callback(error, false);
            }.bind(this)
          );
        }.bind(this))
        .on('set', function (powerOn, callback) {
          this.setPlaying(powerOn).then(function () {
            callback(false, powerOn);
          }, function (error) {
            callback(error, !powerOn); //TODO: Actually determine and send real new status.
          });
        }.bind(this));

      zoneService.addCharacteristic(new Characteristic.Brightness())
        .on('get', function (callback, context) {
          yamaha.getBasicInfo(that.zone).then(function (basicInfo) {
            var v = basicInfo.getVolume() / 10.0;
            var p = 100 * ((v - that.minVolume) / that.gapVolume);
            p = p < 0 ? 0 : p > 100 ? 100 : Math.round(p);
            debug("Got volume percent of " + v + "%, " + p + "% ", that.zone);
            callback(false, p);
          }, function (error) {
            callback(error, 0);
          });
        })
        .on('set', function (p, callback) {
          var v = ((p / 100) * that.gapVolume) + that.minVolume;
          v = Math.round(v) * 10.0;
          debug("Setting volume to " + v + "%, " + p + "% ", that.zone);
          yamaha.setVolumeTo(v, that.zone).then(function (response) {
            debug("Success", response);
            callback(false, p);
          }, function (error) {
            callback(error, volCx.value);
          });
        });


      return [informationService, zoneService];
    }
  };

  homebridge.registerPlatform("homebridge-yamaha-home", "yamaha-home", YamahaAVRPlatform);
};
