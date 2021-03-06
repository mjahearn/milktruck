// milktruck.js
/*
Copyright 2008 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Code for Monster Milktruck demo, using Earth Plugin.

window.truck = null;

// Pull the Milktruck model from 3D Warehouse.
var PAGE_PATH = document.location.href.replace(/\/[^\/]+$/, '/');
var MODEL_URL = 'http://web.mit.edu/eronsis/www/doc.kml';
var INIT_LOC = {
 lat: 42.352778,
 lon: -71.066667,
  heading: 0
}; // boston common

var PREVENT_START_AIRBORNE = false;
var TICK_MS = 66;

var BALLOON_FG = '#000000';
var BALLOON_BG = '#FFFFFF';

var GRAVITY = 9.8;
var CAM_HEIGHT = 10;
var TRAILING_DISTANCE = 20;

var ACCEL = 25.0;
var DECEL = 40.0;
var MAX_REVERSE_SPEED = 20.0;
var MAX_FORWARD_SPEED = 25.0;

var STEER_ROLL = -1.0;
var ROLL_SPRING = 0.5;
var ROLL_DAMP = -0.16;

var NUM_PASSENGERS = 2000;
var PASSENGER_THRESHOLD = 500;

var placemark = null;
var places = null;
var curPlace = 0;
var passengerCounter = 0;
var money = 0;

var hasCustomer = false;

var personmarks = null;
var pmIndices = null;
var customers = null;
var custIsVisible = null;

var destPointer = null;
var directions = null;

function Truck() {
  var me = this;

  me.doTick = true;
  
  // We do all our motion relative to a local coordinate frame that is
  // anchored not too far from us.  In this frame, the x axis points
  // east, the y axis points north, and the z axis points straight up
  // towards the sky.
  //
  // We periodically change the anchor point of this frame and
  // recompute the local coordinates.
  me.localAnchorLla = [0, 0, 0];
  me.localAnchorCartesian = V3.latLonAltToCartesian(me.localAnchorLla);
  me.localFrame = M33.identity();

  // Position, in local cartesian coords.
  me.pos = [0, 0, 0];
  
  // Velocity, in local cartesian coords.
  me.vel = [0, 0, 0];

  // Orientation matrix, transforming model-relative coords into local
  // coords.
  me.modelFrame = M33.identity();

  me.roll = 0;
  me.rollSpeed = 0;
  
  me.idleTimer = 0;
  me.fastTimer = 0;
  me.popupTimer = 0;

  ge.getOptions().setMouseNavigationEnabled(false);
  ge.getOptions().setFlyToSpeed(100);  // don't filter camera motion

  window.google.earth.fetchKml(ge, MODEL_URL,
                               function(obj) { me.finishInit(obj); });
}

Truck.prototype.finishInit = function(kml) {
  var me = this;

  walkKmlDom(kml, function() {
    if (this.getType() == 'KmlPlacemark' &&
        this.getGeometry() &&
        this.getGeometry().getType() == 'KmlModel')
      me.placemark = this;
  });

  me.model = me.placemark.getGeometry();
  me.orientation = me.model.getOrientation();
  me.location = me.model.getLocation();

  me.model.setAltitudeMode(ge.ALTITUDE_ABSOLUTE);
  me.orientation.setHeading(90);
  me.model.setOrientation(me.orientation);

  ge.getFeatures().appendChild(me.placemark);

  me.balloon = ge.createHtmlStringBalloon('');
  me.balloon.setFeature(me.placemark);
  me.balloon.setMaxWidth(350);
  me.balloon.setForegroundColor(BALLOON_FG);
  me.balloon.setBackgroundColor(BALLOON_BG);

  me.teleportTo(INIT_LOC.lat, INIT_LOC.lon, INIT_LOC.heading);

  me.lastMillis = (new Date()).getTime();

  var href = window.location.href;

  me.shadow = ge.createGroundOverlay('');
  me.shadow.setVisibility(false);
  me.shadow.setIcon(ge.createIcon(''));
  me.shadow.setLatLonBox(ge.createLatLonBox(''));
  me.shadow.setAltitudeMode(ge.ALTITUDE_CLAMP_TO_SEA_FLOOR);
  me.shadow.getIcon().setHref(PAGE_PATH + 'shadowrect.png');
  me.shadow.setVisibility(false);
  ge.getFeatures().appendChild(me.shadow);

	places = getPlaces();
	customers = getCustomers();
	showCustomers(me);
	createCompass(me);

  google.earth.addEventListener(ge, "frameend", function() { me.tick(); });

  me.cameraCut();

  // Make sure keyboard focus starts out on the page.
  ge.getWindow().blur();

  // If the user clicks on the Earth window, try to restore keyboard
  // focus back to the page.
  google.earth.addEventListener(ge.getWindow(), "mouseup", function(event) {
      ge.getWindow().blur();
    });
}

leftButtonDown = false;
rightButtonDown = false;
gasButtonDown = false;
reverseButtonDown = false;

function keyDown(event) {
  if (!event) {
    event = window.event;
  }
  if (event.keyCode == 37) {  // Left.
    leftButtonDown = true;
    event.returnValue = false;
  } else if (event.keyCode == 39) {  // Right.
    rightButtonDown = true;
    event.returnValue = false;
  } else if (event.keyCode == 38) {  // Up.
    gasButtonDown = true;
    event.returnValue = false;
  } else if (event.keyCode == 40) {  // Down.
    reverseButtonDown = true;
    event.returnValue = false;
  } else {
    return true;
  }
  return false;
}

function keyUp(event) {
  if (!event) {
    event = window.event;
  }
  if (event.keyCode == 37) {  // Left.
    leftButtonDown = false;
    event.returnValue = false;
  } else if (event.keyCode == 39) {  // Right.
    rightButtonDown = false;
    event.returnValue = false;
  } else if (event.keyCode == 38) {  // Up.
    gasButtonDown = false;
    event.returnValue = false;
  } else if (event.keyCode == 40) {  // Down.
    reverseButtonDown = false;
    event.returnValue = false;
  }
  return false;
}

function clamp(val, min, max) {
  if (val < min) {
    return min;
  } else if (val > max) {
    return max;
  }
  return val;
}

function isColliding(t) {
    var lat = t.model.getLocation().getLatitude();
    var lon = t.model.getLocation().getLongitude();
    var alt = t.model.getLocation().getAltitude();
    var screencoords = ge.getView().project(lat,lon,alt,ge.ALTITUDE_ABSOLUTE);
    var result = ge.getView().hitTest(screencoords.getX(), screencoords.getXUnits(), screencoords.getY(), screencoords.getYUnits(), ge.HIT_TEST_BUILDINGS);
    if (result != null) {
        var d = distance(lat, lon, result.getLatitude(), result.getLongitude());
        if (d < 8) {
            return d;
        }
    }
    return null
    
}

Truck.prototype.tick = function() {
  var me = this;
  
  var now = (new Date()).getTime();
  // dt is the delta-time since last tick, in seconds
  var dt = (now - me.lastMillis) / 1000.0;
  if (dt > 0.25) {
    dt = 0.25;
  }
  me.lastMillis = now;
  me.lastCollision = 0;

  var c0 = 1;
  var c1 = 0;

  var gpos = V3.add(me.localAnchorCartesian,
                    M33.transform(me.localFrame, me.pos));
  var lla = V3.cartesianToLatLonAlt(gpos);

  if (V3.length([me.pos[0], me.pos[1], 0]) > 100) {
    // Re-anchor our local coordinate frame whenever we've strayed a
    // bit away from it.  This is necessary because the earth is not
    // flat!
    me.adjustAnchor();
  }

  var dir = me.modelFrame[1];
  var up = me.modelFrame[2];

  var absSpeed = V3.length(me.vel);

  var groundAlt = ge.getGlobe().getGroundAltitude(lla[0], lla[1]);
  var airborne = (groundAlt + 0.30 < me.pos[2]);
  var steerAngle = 0;
  
  // Steering.
  if (leftButtonDown || rightButtonDown) {
    var TURN_SPEED_MIN = 60.0;  // radians/sec
    var TURN_SPEED_MAX = 100.0;  // radians/sec
 
    var turnSpeed;

    // Degrade turning at higher speeds.
    //
    //           angular turn speed vs. vehicle speed
    //    |     -------
    //    |    /       \-------
    //    |   /                 \-------
    //    |--/                           \---------------
    //    |
    //    +-----+-------------------------+-------------- speed
    //    0    SPEED_MAX_TURN           SPEED_MIN_TURN
    var SPEED_MAX_TURN = 25.0;
    var SPEED_MIN_TURN = 120.0;
    if (absSpeed < SPEED_MAX_TURN) {
      turnSpeed = TURN_SPEED_MIN + (TURN_SPEED_MAX - TURN_SPEED_MIN)
                   * (SPEED_MAX_TURN - absSpeed) / SPEED_MAX_TURN;
      turnSpeed *= (absSpeed / SPEED_MAX_TURN);  // Less turn as truck slows
    } else if (absSpeed < SPEED_MIN_TURN) {
      turnSpeed = TURN_SPEED_MIN + (TURN_SPEED_MAX - TURN_SPEED_MIN)
                  * (SPEED_MIN_TURN - absSpeed)
                  / (SPEED_MIN_TURN - SPEED_MAX_TURN);
    } else {
      turnSpeed = TURN_SPEED_MIN;
    }
    if (leftButtonDown) {
      steerAngle = turnSpeed * dt * Math.PI / 180.0;
    }
    if (rightButtonDown) {
      steerAngle = -turnSpeed * dt * Math.PI / 180.0;
    }
  }
  
  // Turn.
  var newdir = airborne ? dir : V3.rotate(dir, up, steerAngle);
  me.modelFrame = M33.makeOrthonormalFrame(newdir, up);
  dir = me.modelFrame[1];
  up = me.modelFrame[2];

  var forwardSpeed = 0;
  
  if (!airborne) {
    // TODO: if we're slipping, transfer some of the slip
    // velocity into forward velocity.

    // Damp sideways slip.  Ad-hoc frictiony hack.
    //
    //
    // I'm using a damped exponential filter here, like:
    // val = val * c0 + val_new * (1 - c0)
    //
    // For a variable time step:
    //  c0 = exp(-dt / TIME_CONSTANT)
    var right = me.modelFrame[0];
    var slip = V3.dot(me.vel, right);
    c0 = Math.exp(-dt / 0.5);
    me.vel = V3.sub(me.vel, V3.scale(right, slip * (1 - c0)));

    // Apply engine/reverse accelerations.
    forwardSpeed = V3.dot(dir, me.vel);
    
    if (gasButtonDown) {
      // Accelerate forwards.
      me.vel = V3.add(me.vel, V3.scale(dir, ACCEL * dt));
    } else if (reverseButtonDown) {
      if (forwardSpeed > -MAX_REVERSE_SPEED)
        me.vel = V3.add(me.vel, V3.scale(dir, -DECEL * dt));
    }
  }

  // Air drag.
  //
  // Fd = 1/2 * rho * v^2 * Cd * A.
  // rho ~= 1.2 (typical conditions)
  // Cd * A = 3 m^2 ("drag area")
  //
  // I'm simplifying to:
  //
  // accel due to drag = 1/Mass * Fd
  // with Milktruck mass ~= 2000 kg
  // so:
  // accel = 0.6 / 2000 * 3 * v^2
  // accel = 0.0009 * v^2
  absSpeed = V3.length(me.vel);
  if (absSpeed > 0.01) {
    var veldir = V3.normalize(me.vel);
    var DRAG_FACTOR = 0.00090;
    var drag = absSpeed * absSpeed * DRAG_FACTOR;

    // Some extra constant drag (rolling resistance etc) to make sure
    // we eventually come to a stop.
    var CONSTANT_DRAG = 2.0;
    drag += CONSTANT_DRAG;

    if (drag > absSpeed) {
      drag = absSpeed;
    }

    me.vel = V3.sub(me.vel, V3.scale(veldir, drag * dt));
  }

  // Gravity
  me.vel[2] -= GRAVITY * dt;

  // Move.
  d = isColliding(me);
  if(d != null && now - me.lastCollision > 500) {
    me.vel = V3.scale(me.vel, -0.30);
    me.pos = V3.add(me.pos, V3.scale(me.vel, 4*dt));
  }

  
  var deltaPos = V3.scale(me.vel, dt);
  me.pos = V3.add(me.pos, deltaPos);

  gpos = V3.add(me.localAnchorCartesian,
                M33.transform(me.localFrame, me.pos));
  lla = V3.cartesianToLatLonAlt(gpos);
  
  // Don't go underground.
  groundAlt = ge.getGlobe().getGroundAltitude(lla[0], lla[1]);
  if (me.pos[2] < groundAlt) {
    me.pos[2] = groundAlt;
  }

  var normal = estimateGroundNormal(gpos, me.localFrame);
  
  
  if (!airborne) {
    // Cancel velocity into the ground.
    //
    // TODO: would be fun to add a springy suspension here so
    // the truck bobs & bounces a little.
    var speedOutOfGround = V3.dot(normal, me.vel);
    if (speedOutOfGround < 0) {
      me.vel = V3.add(me.vel, V3.scale(normal, -speedOutOfGround));
    }

    // Make our orientation follow the ground.
    c0 = Math.exp(-dt / 0.25);
    c1 = 1 - c0;
    var blendedUp = V3.normalize(V3.add(V3.scale(up, c0),
                                        V3.scale(normal, c1)));
    me.modelFrame = M33.makeOrthonormalFrame(dir, blendedUp);
  }

  
  
  // Propagate our state into Earth.
  gpos = V3.add(me.localAnchorCartesian,
                M33.transform(me.localFrame, me.pos));
  lla = V3.cartesianToLatLonAlt(gpos);
  me.model.getLocation().setLatLngAlt(lla[0], lla[1], lla[2]);

  var newhtr = M33.localOrientationMatrixToHeadingTiltRoll(me.modelFrame);

  // Compute roll according to steering.
  // TODO: this would be even more cool in 3d.
  var absRoll = newhtr[2];
  me.rollSpeed += steerAngle * forwardSpeed * STEER_ROLL;
  // Spring back to center, with damping.
  me.rollSpeed += (ROLL_SPRING * -me.roll + ROLL_DAMP * me.rollSpeed);
  me.roll += me.rollSpeed * dt;
  me.roll = clamp(me.roll, -30, 30);
  absRoll += me.roll;

  me.orientation.set(newhtr[0], newhtr[1], absRoll);

  var latLonBox = me.shadow.getLatLonBox();
  var radius = .00005;
  latLonBox.setNorth(lla[0] - radius);
  latLonBox.setSouth(lla[0] + radius);
  latLonBox.setEast(lla[1] - radius);
  latLonBox.setWest(lla[1] + radius);
  latLonBox.setRotation(-newhtr[0]);

  me.tickPopups(dt);
  
  me.cameraFollow(dt, gpos, me.localFrame);
	
	var speed = V3.length(me.vel);
	var realPos = new Array(me.model.getLocation().getLatitude(),
		me.model.getLocation().getLongitude());
	var realGPos = new GLatLng(realPos[0], realPos[1]);
	
	map.panTo(realGPos);
	playerMarker.setLatLng(realGPos);
	
	if (hasCustomer) {
		var dist = distance(realPos[0], realPos[1],
			placemark.getGeometry().getLatitude(),
			placemark.getGeometry().getLongitude());

		if (dist < 10 && speed < 5) {
			ge.getFeatures().removeChild(placemark);
			ge.getFeatures().removeChild(destPointer);
			hasCustomer = false;
			showCustomers(me);
		}
	} else {
		for (var b = 0; b < customers.length; b++) {
			var d = distance(realPos[0], realPos[1],
				customers[b][1], customers[b][2]);
			if (d < PASSENGER_THRESHOLD && !custIsVisible[b]) {
				addPersonmark(b);
			}
		}
		for (var a = 0; a < personmarks.length; a++) {
			var dist = distance(realPos[0], realPos[1],
				personmarks[a].getGeometry().getLatitude(),
				personmarks[a].getGeometry().getLongitude());
			
			if (dist > PASSENGER_THRESHOLD) {
				removePersonmark(a);
			} else if (dist < 10 && speed < 5) {
				for (var b = 0; b < personmarks.length; b++) {
					ge.getFeatures().removeChild(personmarks[b]);
				}
				hasCustomer = true;
				ge.getFeatures().appendChild(destPointer);
				newDestination(me);
				break;
			}
		}
	}
};

// TODO: would be nice to have globe.getGroundNormal() in the API.
function estimateGroundNormal(pos, frame) {
  // Take four height samples around the given position, and use it to
  // estimate the ground normal at that position.
  //  (North)
  //     0
  //     *
  //  2* + *3
  //     *
  //     1
  var pos0 = V3.add(pos, frame[0]);
  var pos1 = V3.sub(pos, frame[0]);
  var pos2 = V3.add(pos, frame[1]);
  var pos3 = V3.sub(pos, frame[1]);
  var globe = ge.getGlobe();
  function getAlt(p) {
    var lla = V3.cartesianToLatLonAlt(p);
    return globe.getGroundAltitude(lla[0], lla[1]);
  }
  var dx = getAlt(pos1) - getAlt(pos0);
  var dy = getAlt(pos3) - getAlt(pos2);
  var normal = V3.normalize([dx, dy, 2]);
  return normal;
}

// Decide when to open & close popup messages.
Truck.prototype.tickPopups = function(dt) {
  var me = this;
  var speed = V3.length(me.vel);
  if (me.popupTimer > 0) {
    me.popupTimer -= dt;
    me.idleTimer = 0;
    me.fastTimer = 0;
    if (me.popupTimer <= 0) {
      me.popupTimer = 0;
      ge.setBalloon(null);
    }
  } else {
    if (speed < 20) {
      me.idleTimer += dt;
      if (me.idleTimer > 10.0) {
        me.showIdlePopup();
      }
      me.fastTimer = 0;
    } else {
      me.idleTimer = 0;
      if (speed > 80) {
        me.fastTimer += dt;
        if (me.fastTimer > 7.0) {
          me.showFastPopup();
        }
      } else {
        me.fastTimer = 0;
      }
    }
  }
};

var IDLE_MESSAGES = [
    "You're running out of time!!",
    "Hey, are you still there?",
    "Dude, <font color=red><i>step on it!</i></font>",
    "Someone is waiting for you! Hurry up!",
    "We've got passengers waiting!",
    "Zzzzzzz...",
    "We have so many places to go to! Hurry up!"
                     ];
Truck.prototype.showIdlePopup = function() {
  var me = this;
  me.popupTimer = 2.0;
  var rand = Math.random();
  var index = Math.floor(rand * IDLE_MESSAGES.length)
    % IDLE_MESSAGES.length;
  var message = "<center>" + IDLE_MESSAGES[index] + "</center>";
  me.balloon.setContentString(message);
  ge.setBalloon(me.balloon);
};

var FAST_MESSAGES = [
    "We're flying!",
    "Wheeeeeeeeee!",
    "<font size=+5 color=#8080FF>Crazy Taxi!</font>",
    "Oh yay! We're gonna arrive in a few seconds!"
                     ];
Truck.prototype.showFastPopup = function() {
  var me = this;
  me.popupTimer = 2.0;
  var rand = Math.random();
  var index = Math.floor(rand * FAST_MESSAGES.length)
    % FAST_MESSAGES.length;
  var message = "<center>" + FAST_MESSAGES[index] + "</center>";
  me.balloon.setContentString(message);
  ge.setBalloon(me.balloon);
};

Truck.prototype.scheduleTick = function() {
  var me = this;
  if (me.doTick) {
    setTimeout(function() { me.tick(); }, TICK_MS);
  }
};

// Cut the camera to look at me.
Truck.prototype.cameraCut = function() {
  var me = this;
  var lo = me.model.getLocation();
  var la = ge.createLookAt('');
  la.set(lo.getLatitude(), lo.getLongitude(),
         10 /* altitude */,
         ge.ALTITUDE_RELATIVE_TO_SEA_FLOOR,
         fixAngle(180 + me.model.getOrientation().getHeading() + 45),
         80, /* tilt */
         50 /* range */         
         );
  ge.getView().setAbstractView(la);
};

Truck.prototype.cameraFollow = function(dt, truckPos, localToGlobalFrame) {
  var me = this;

  var c0 = Math.exp(-dt / 0.5);
  var c1 = 1 - c0;

  var la = ge.getView().copyAsLookAt(ge.ALTITUDE_RELATIVE_TO_SEA_FLOOR);

  var truckHeading = me.model.getOrientation().getHeading();
  var camHeading = la.getHeading();

  var deltaHeading = fixAngle(truckHeading - camHeading);
  var heading = camHeading + c1 * deltaHeading;
  heading = fixAngle(heading);

  var headingRadians = heading / 180 * Math.PI;
  
  var headingDir = V3.rotate(localToGlobalFrame[1], localToGlobalFrame[2],
                             -headingRadians);
  var camPos = V3.add(truckPos, V3.scale(localToGlobalFrame[2], CAM_HEIGHT));
  camPos = V3.add(camPos, V3.scale(headingDir, -TRAILING_DISTANCE));
  var camLla = V3.cartesianToLatLonAlt(camPos);
  var camLat = camLla[0];
  var camLon = camLla[1];
  var camAlt = camLla[2] - ge.getGlobe().getGroundAltitude(camLat, camLon);

  la.set(camLat, camLon, camAlt, ge.ALTITUDE_RELATIVE_TO_SEA_FLOOR, 
        heading, 80 /*tilt*/, 0 /*range*/);
  ge.getView().setAbstractView(la);
};

// heading is optional.
Truck.prototype.teleportTo = function(lat, lon, heading) {
  var me = this;
  me.model.getLocation().setLatitude(lat);
  me.model.getLocation().setLongitude(lon);
  me.model.getLocation().setAltitude(ge.getGlobe().getGroundAltitude(lat, lon));
  if (heading == null) {
    heading = 0;
  }
  me.vel = [0, 0, 0];

  me.localAnchorLla = [lat, lon, 0];
  me.localAnchorCartesian = V3.latLonAltToCartesian(me.localAnchorLla);
  me.localFrame = M33.makeLocalToGlobalFrame(me.localAnchorLla);
  me.modelFrame = M33.identity();
  me.modelFrame[0] = V3.rotate(me.modelFrame[0], me.modelFrame[2], -heading);
  me.modelFrame[1] = V3.rotate(me.modelFrame[1], me.modelFrame[2], -heading);
  me.pos = [0, 0, ge.getGlobe().getGroundAltitude(lat, lon)];

  me.cameraCut();

  // make sure to not start airborne
  if (PREVENT_START_AIRBORNE) {
    window.setTimeout(function() {
      var groundAlt = ge.getGlobe().getGroundAltitude(lat, lon);
      var airborne = (groundAlt + 0.30 < me.pos[2]);
      if (airborne)
        me.teleportTo(lat, lon, heading);
    }, 500);
  }
};

// Move our anchor closer to our current position.  Retain our global
// motion state (position, orientation, velocity).
Truck.prototype.adjustAnchor = function() {
  var me = this;
  var oldLocalFrame = me.localFrame;

  var globalPos = V3.add(me.localAnchorCartesian,
                         M33.transform(oldLocalFrame, me.pos));
  var newAnchorLla = V3.cartesianToLatLonAlt(globalPos);
  newAnchorLla[2] = 0;  // For convenience, anchor always has 0 altitude.

  var newAnchorCartesian = V3.latLonAltToCartesian(newAnchorLla);
  var newLocalFrame = M33.makeLocalToGlobalFrame(newAnchorLla);

  var oldFrameToNewFrame = M33.transpose(newLocalFrame);
  oldFrameToNewFrame = M33.multiply(oldFrameToNewFrame, oldLocalFrame);

  var newVelocity = M33.transform(oldFrameToNewFrame, me.vel);
  var newModelFrame = M33.multiply(oldFrameToNewFrame, me.modelFrame);
  var newPosition = M33.transformByTranspose(
      newLocalFrame,
      V3.sub(globalPos, newAnchorCartesian));

  me.localAnchorLla = newAnchorLla;
  me.localAnchorCartesian = newAnchorCartesian;
  me.localFrame = newLocalFrame;
  me.modelFrame = newModelFrame;
  me.pos = newPosition;
  me.vel = newVelocity;
}

// Keep an angle in [-180,180]
function fixAngle(a) {
  while (a < -180) {
    a += 360;
  }
  while (a > 180) {
    a -= 360;
  }
  return a;
}

/* Helper function, courtesy of
   http://www.movable-type.co.uk/scripts/latlong.html */

function distance(lat1, lng1, lat2, lng2) {
  if (typeof(Number.prototype.toRad) === "undefined") {
    Number.prototype.toRad = function() {
      return this * Math.PI / 180;
    }
  }
  var R = 6371000; // radius of Earth, in meters
  var dLat = (lat2-lat1).toRad();
  var dLon = (lng2-lng1).toRad();
  var lat1 = lat1.toRad();
  var lat2 = lat2.toRad();

  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2); 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c;
  return d;
}

/* Helper function, courtesy of
   http://www.movable-type.co.uk/scripts/latlong.html */

function bearing(lat1, lng1, lat2, lng2) {
	var dLon = (lng2-lng1).toRad();
  var aLat1 = lat1.toRad();
  var aLat2 = lat2.toRad();
	var y = Math.sin(dLon) * Math.cos(aLat2);
	var x = Math.cos(aLat1)*Math.sin(aLat2) -
		Math.sin(aLat1)*Math.cos(aLat2)*Math.cos(dLon);
	var result = Math.atan2(y, x) * 180 / Math.PI;
	return result;
}


function getPlaces() {
  var result = new Array();
  
  /*result[0] = new Array("Meeting Spot", 42.353778, -71.066667);
  result[1] = new Array("Vic's Car Dealership", 42.354778, -71.065667);
  result[2] = new Array("The Watering Hole", 42.354778, -71.066667);
  result[3] = new Array("County Jail", 42.353778, -71.065667);*/
	
	result[0] = new Array("Old North Church",
		42.36643523315836, -71.05466734894992);
  result[1] = new Array("City Hall",
		42.3596374029632, -71.0586678872094);
  result[2] = new Array("New England Aquarium",
		42.35896991287691, -71.05067356325343);
  result[3] = new Array("South Station", 
		42.35251917380683, -71.05535827654184);
	result[4] = new Array("Massachusetts General Hospital",
		42.36241981594357, -71.06871799620129);
  result[5] = new Array("Boston Common",
		42.35527016681368, -71.06331744791147);
  result[6] = new Array("Cheers Beacon Hill",
		42.35585801045627, -71.07111904764524);
  result[7] = new Array("TD Garden",
		42.36629143721431, -71.06118465116826);
	result[8] = new Array("Pizzeria Regina",
		42.3653522106625, -71.05681891694918);
  result[9] = new Array("Haymarket",
		42.36165525867651, -71.0561346917995);
  result[10] = new Array("Museum of Science",
		42.36789096202344, -71.07107509890592);
  result[11] = new Array("State House", 
		42.35763919930955, -71.06354636401163);
	result[12] = new Array("Faneuil Hall",
		42.35994515655787, -71.05699986856368);
  result[13] = new Array("Hatch Shell",
		42.35723719043404, -71.07302736608241);
  result[14] = new Array("Louisburg Square",
		42.35882060575234, -71.06884559360742);
  result[15] = new Array("Norman B. Leventhal Park",
		42.35586516445154, -71.05529679549636);
	result[16] = new Array("Paul Revere House",
		42.36360434928332, -71.05366135635192);
  result[17] = new Array("Emerson College",
		42.35241637721636, -71.06595688928579);
  result[18] = new Array("Boston Police Department",
		42.36167462863499, -71.06018802254458);
  result[19] = new Array("Public Garden",
		42.35369416516925, -71.07150917512978);
	result[20] = new Array("Downtown Crossing",
		42.35495031378549, -71.05976844846495);
	
  return result;
}

function newDestination(me) {
  curPlace = Math.floor(Math.random()*places.length);
  
  placemark = ge.createPlacemark('');
  placemark.setName(places[curPlace][0]);
  
  var icon = ge.createIcon('');
  icon.setHref('http://maps.google.com/mapfiles/kml/paddle/red-circle.png');
  var style = ge.createStyle('');
  style.getIconStyle().setIcon(icon);
  placemark.setStyleSelector(style);
  
  var point = ge.createPoint('');
  point.setLatitude(places[curPlace][1]);
  point.setLongitude(places[curPlace][2]);
  placemark.setGeometry(point);
  
  ge.getFeatures().appendChild(placemark);
  passengerCounter = passengerCounter + 1;
  money = money + 0.1*abs(getPlaces[curPlace-1][1]-getPlaces[curPlace][1])+ 0.1*abs(getPlaces[curPlace-1][1]-getPlaces[curPlace][2]);
	document.getElementById('destination').innerHTML = "Find the red marker and bring the passengers to <b>" + places[curPlace][0] + "</b>";
	document.getElementById('number').innerHTML = "Passenger counter: <b>" + passengerCounter + "</b>";
	document.getElementById('money').innerHTML = "Money earned: <b>" + money + "</b>";
	
	directions = new GDirections(map);
  directions.load("from: " + me.model.getLocation().getLatitude().toString()
		+ "," + me.model.getLocation().getLongitude().toString()
		+ " to: " + places[curPlace][1].toString()
		+ "," + places[curPlace][2].toString());
}


function handleErrors() {
	document.getElementById('destination').innerHTML = "oh no";
}

function getCustomers() {
	var result = new Array();
	custIsVisible = new Array();

	//first item = index # (in places array) of the destination they want to go to
	/*result[0] = new Array(2, 42.355778, -71.066667);
	result[1] = new Array(0, 42.355778, -71.065667);
	result[2] = new Array(1, 42.355778, -71.064667);*/
	
	var minLon = -71.073611;
	var maxLon = -71.049722;
	var minLat = 41.351944;
	var maxLat = 42.368611;
	for (var a = 0; a < NUM_PASSENGERS; a++) {
		var x = Math.random()*(maxLon-minLon)+minLon;
		var y = Math.random()*(maxLat-minLat)+minLat;
		var l = Math.random()*places.length;
		
		result[a] = new Array(l, y, x);
		custIsVisible[a] = false;
	}

	return result;
}

function showCustomers(me) {
	if (directions != null){
		directions.clear();
	}
	personmarks = new Array();
	pmIndices = new Array();
	var minD = -1;
	for (var a = 0; a < customers.length; a++) {
		var d = distance(me.model.getLocation().getLatitude(),
				me.model.getLocation().getLongitude(),
				customers[a][1], customers[a][2]);
		if (minD == -1 || d < minD) {
			minD = d;
		}
		if (d < PASSENGER_THRESHOLD) {
			addPersonmark(a);
		}
	}
	document.getElementById('destination').innerHTML = "<b>Find the yellow marker and brake to pick up a passenger!</b>";
	//document.getElementById('destination').innerHTML = minD.toString();
}

function changeTextColor() {
  document.getElementById('destination').style.color = '#ffffff';
  document.getElementById('number').style.color = '#ffffff';
  document.getElementById('timerRow').style.color = '#ffffff';
  document.getElementById('money').style.color = '#ffffff';
  
}

function addPersonmark(ind) {
	personmarks.push(ge.createPlacemark(''));
	pmIndices.push(ind);
		
	var icon = ge.createIcon('');
	icon.setHref('http://maps.google.com/mapfiles/ms/micons/yellow-dot.png');
	var style = ge.createStyle('');
	style.getIconStyle().setIcon(icon);
	personmarks[personmarks.length - 1].setStyleSelector(style);
	
	var point = ge.createPoint('');
	point.setLatitude(customers[ind][1]);
	point.setLongitude(customers[ind][2]);
	personmarks[personmarks.length - 1].setGeometry(point);
	
	custIsVisible[ind] = true;
	ge.getFeatures().appendChild(personmarks[personmarks.length - 1]);
}

function removePersonmark(ind) {
	custIsVisible[pmIndices[ind]] = false;
	ge.getFeatures().removeChild(personmarks[ind]);
	personmarks.splice(ind,1);
	pmIndices.splice(ind,1);
}

function createCompass(me) {
  // create compass
  var icon = ge.createIcon('');
  icon.setHref('http://earth-api-samples.googlecode.com/svn/trunk/demos/milktruck/compass.png');
  
  var compass = ge.createScreenOverlay('');
  compass.setDrawOrder(1);
  compass.setIcon(icon);
  compass.getScreenXY().set(0.5, ge.UNITS_FRACTION, 0.5, ge.UNITS_FRACTION);
  compass.getOverlayXY().set(0.5, ge.UNITS_FRACTION, 50, ge.UNITS_INSET_PIXELS);
  compass.getSize().set(74, ge.UNITS_PIXELS, 74, ge.UNITS_PIXELS);
  ge.getFeatures().appendChild(compass);
	
	var icon2 = ge.createIcon('');
  icon2.setHref('http://maps.google.com/mapfiles/kml/paddle/red-circle.png');
  
  destPointer = ge.createScreenOverlay('');
  destPointer.setDrawOrder(1);
  destPointer.setIcon(icon2);
  destPointer.getScreenXY().set(0.5, ge.UNITS_FRACTION, 0.5, ge.UNITS_FRACTION);
  destPointer.getOverlayXY().set(0.5, ge.UNITS_FRACTION, 24, ge.UNITS_INSET_PIXELS);
	destPointer.getRotationXY().set(0.5, ge.UNITS_FRACTION, 100, ge.UNITS_INSET_PIXELS);
  destPointer.getSize().set(24, ge.UNITS_PIXELS, 24, ge.UNITS_PIXELS); //native: 64x64
  //ge.getFeatures().appendChild(destPointer);
  
  google.earth.addEventListener(ge.getView(), 'viewchange', function() {
    var compassHeading = truck.model.getOrientation().getHeading();
		if (hasCustomer) {
			var placemarkBearing = bearing(me.model.getLocation().getLatitude(),
				me.model.getLocation().getLongitude(),
				placemark.getGeometry().getLatitude(),
				placemark.getGeometry().getLongitude());
			destPointer.setRotation(compassHeading - placemarkBearing);
		}
		compass.setRotation(compassHeading);
  });
}
