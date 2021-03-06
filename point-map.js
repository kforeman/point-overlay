/**
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* global CanvasLayer, ShaderProgram */

/**
 * A CanvasLayer-based overlay for easy point maps using WebGL.
 * @param {!google.maps.Map} map
 */
function PointMap(map) {
  /**
   * The host map object.
   * @private {!google.maps.Map}
   */
  this.map_ = map;

  /**
   * The ratio between physical-device pixels and DPI-adjusted logical CSS
   * pixels. Defaults to 1 if window.devicePixelRatio is not found.
   * @private {number}
   */
  this.resolutionScale_ = window.devicePixelRatio || 1;

  /**
   * The map layer that manages the canvas overlay, events, and scheduling.
   * @private {!CanvasLayer}
   */
  this.canvasLayer_ = new CanvasLayer({
    map: map,
    animate: false,
    resizeHandler: this.resize_.bind(this),
    resolutionScale: this.resolutionScale_
  });

  /**
   * The WebGL context.
   * @private {!WebGLRenderingContext}
   */
  this.gl_ = this.canvasLayer_.canvas.getContext('webgl');

  /**
   * The ShaderProgram for drawing the points, initialized with the default
   * shaders.
   * @private {!ShaderProgram}
   */
  this.pointProgram_ = new ShaderProgram(this.gl_,
      PointMap.DEFAULT_VERT_SHADER_, PointMap.DEFAULT_FRAG_SHADER_);

  /**
   * The WebGL array buffer containing the points' coordinates.
   * @private {WebGLBuffer}
   */
  this.pointArrayBuffer_ = null;
  this.colorBuffer_ = null;

  /**
   * The number of points to render
   * @private {number}
   */
  this.pointCount_ = 0;

  /**
   * The transform mapping pixel coordinates to WebGL coordinates.
   * @private {!Float32Array}
   */
  this.pixelsToWebGLMatrix_ = new Float32Array(16);

  /**
   * The matrix for calculating (map) world coordinates to pixel transform.
   * @private {!Float32Array}
   */
  this.mapMatrix_ = new Float32Array(16);

  /**
   * The base point size.
   * @private {number}
   */
  this.pointScale_ = 1 / 256;

  /**
   * The base point opacity.
   * @private {number}
   */
  this.globalAlpha_ = 0.4;
}

/**
 * Default fragment shader source.
 * @private {string}
 */
PointMap.DEFAULT_FRAG_SHADER_ = [
    'precision mediump float;',

    //'const vec4 color = vec4(.3, .6, .85, .5);',
    'const vec4 blank = vec4(0.);',
    'const float filterPixelWidth = 1.4142135623730951;',

    'varying float alpha;',
    'varying float pointWidth;',
    'varying lowp vec4 vColor;',


    'void main() {',
    '  float dist = length(gl_PointCoord - .5);',
    '  float filterWidth = filterPixelWidth / pointWidth;',
    '  float filtered = smoothstep(.5 - filterWidth, .5, dist);',
    //'  gl_FragColor = mix(color, blank, filtered) *  alpha;',
    '  gl_FragColor = mix(vColor, blank, filtered) * alpha;',
    '}'
].join('\n');

/**
 * Default vertex shader source.
 * @private {string}
 */
PointMap.DEFAULT_VERT_SHADER_ = [
    'attribute vec4 worldCoord;',
    'attribute vec4 aVertexColor;',

    'uniform mat4 mapMatrix;',
    'uniform float pointSize;',
    'uniform float pointAlpha;',


    'varying float alpha;',
    'varying float pointWidth;',
    'varying lowp vec4 vColor;',

    'void main() {',
    '  // transform world coordinate by matrix uniform variable',
    '  gl_Position = mapMatrix * worldCoord;',

    '  pointWidth = pointSize;',
    '  gl_PointSize = pointSize;',
    '  alpha = pointAlpha;',

    '  vColor = aVertexColor;',
    '}'
].join('\n');

/**
 * Converts from latitude to vertical world coordinate.
 * @param {number} lat
 * @return {number}
 * @private
 */
PointMap.latToY_ = function(lat) {
  var merc = -Math.log(Math.tan((0.25 + lat / 360) * Math.PI));
  return 128 * (1 + merc / Math.PI);
};

/**
 * Converts from longitude to horizontal world coordinate.
 * @param {number} lng
 * @return {number}
 * @private
 */
PointMap.lngToX_ = function(lng) {
  if (lng > 180) {
    return 256 * (lng / 360 - 0.5);
  }
  return 256 * (lng / 360 + 0.5);
};

/**
 * Applies a 2d scale to a 4x4 transform matrix.
 * @param {!Float32Array} matrix
 * @param {number} scaleX
 * @param {number} scaleY
 * @private
 */
PointMap.scaleMatrix_ = function(matrix, scaleX, scaleY) {
  // scale x and y, which is just scaling first two columns of matrix
  matrix[0] *= scaleX;
  matrix[1] *= scaleX;
  matrix[2] *= scaleX;
  matrix[3] *= scaleX;

  matrix[4] *= scaleY;
  matrix[5] *= scaleY;
  matrix[6] *= scaleY;
  matrix[7] *= scaleY;
};

/**
 * Applies a 2d translation to a 4x4 transform matrix.
 * @param {!Float32Array} matrix
 * @param {number} tx
 * @param {number} ty
 * @private
 */
PointMap.translateMatrix_ = function(matrix, tx, ty) {
  // translation is in last column of matrix
  matrix[12] += matrix[0]*tx + matrix[4]*ty;
  matrix[13] += matrix[1]*tx + matrix[5]*ty;
  matrix[14] += matrix[2]*tx + matrix[6]*ty;
  matrix[15] += matrix[3]*tx + matrix[7]*ty;
};

/**
 * Returns the CanvasLayer overlay.
 * @return {!CanvasLayer}
 */
PointMap.prototype.getCanvasLayer = function() {
  return this.canvasLayer_;
};

/**
 * Schedules an overlay update on the next requestAnimationFrame callback.
 */
PointMap.prototype.scheduleUpdate = function() {
  this.canvasLayer_.scheduleUpdate();
};

/**
 * Sets the data to draw as points.
 * @param {!Array.<{lat: number, lng: number}>} data
 */
PointMap.prototype.setData = function(rawData) {
  // typed array data
  // var data = new Float32Array(arrayBuffer);
  // var pointCount = rawData.length / 5;
  // var points = new Float32Array(pointCount * 2);
  // for (var i = 0; i < pointCount; i++) {
    // points[i * 2] = PointMap.lngToX_(rawData[i * 5 + 1]);
    // points[i * 2 + 1] = PointMap.latToY_(rawData[i * 5]);
  // }

  // json data
  /*this.pointCount_ = rawData.length;
  var points = new Float32Array(this.pointCount_ * 2);
  for (var i = 0; i < this.pointCount_; i++) {
    points[i * 2] = PointMap.lngToX_(rawData[i][0]);
    points[i * 2 + 1] = PointMap.latToY_(rawData[i][1]);
  }*/
  this.arrayCount_ = rawData.length;
  this.pointCount_ = rawData.reduce(function(p,c) { return p+c.coords.length }, 0);
  var points = new Float32Array(this.pointCount_ * 2),
      colors = new Float32Array(this.pointCount_ * 4),
      k = 0;
  for (var i = 0; i < this.arrayCount_; i++) {
    for (var j = 0; j < rawData[i].coords.length; j++) {
      points[k * 2] = PointMap.lngToX_(rawData[i].coords[j][0]);
      points[k * 2 + 1] = PointMap.latToY_(rawData[i].coords[j][1]);
      colors[k * 4] = rawData[i].color[0];
      colors[k * 4 + 1] = rawData[i].color[1];
      colors[k * 4 + 2] = rawData[i].color[2];
      colors[k * 4 + 3] = 1.0;
      k += 1;
    }
  }

  // create webgl buffer, bind it, and load rawData into it
  this.pointArrayBuffer_ = this.gl_.createBuffer();
  this.gl_.bindBuffer(this.gl_.ARRAY_BUFFER, this.pointArrayBuffer_);
  this.gl_.bufferData(this.gl_.ARRAY_BUFFER, points, this.gl_.STATIC_DRAW);

  this.colorArrayBuffer_ = this.gl_.createBuffer();
  this.gl_.bindBuffer(this.gl_.ARRAY_BUFFER, this.colorArrayBuffer_);
  this.gl_.bufferData(this.gl_.ARRAY_BUFFER, colors, this.gl_.STATIC_DRAW);

  this.run_();
};

/**
 * WebGL initialization and starts rendering the data.
 * @private
 */
PointMap.prototype.run_ = function() {
  this.pointProgram_.use();

  // turn on alpha blending
  this.gl_.enable(this.gl_.BLEND);
  this.gl_.blendFunc(this.gl_.ONE, this.gl_.ONE_MINUS_SRC_ALPHA);
  // this.gl_.blendFuncSeparate(this.gl_.ONE, this.gl_.ONE, this.gl_.ONE,
      // this.gl_.ZERO);

  // TODO(bckenny): move this
  this.gl_.enableVertexAttribArray(this.pointProgram_.attributes.worldCoord);
  this.gl_.enableVertexAttribArray(this.pointProgram_.attributes.aVertexColor);

  this.canvasLayer_.setUpdateHandler(this.update_.bind(this));
  this.scheduleUpdate();
};

/**
 * Resizes the WebGL backing buffer when needed.
 * @private
 */
PointMap.prototype.resize_ = function() {
  /*var canvasWidth = this.canvasLayer_.canvas.width;
  var canvasHeight = this.canvasLayer_.canvas.height;
  console.log(canvasHeight, this.canvasLayer_.getMap().getDiv().offsetHeight * this.resolutionScale_)*/
  var mapHeight = this.canvasLayer_.getMap().getDiv().offsetHeight * this.resolutionScale_;
  var mapWidth = this.canvasLayer_.getMap().getDiv().offsetWidth * this.resolutionScale_;
  var resolutionScale = this.resolutionScale_;

  // this.gl_.viewport(0, 0, canvasWidth, canvasHeight);
  this.gl_.viewport(0, 0, mapWidth, mapHeight);

  this.pixelsToWebGLMatrix_.set([
    // 2 * resolutionScale / canvasWidth, 0, 0, 0,
    2 * resolutionScale / mapWidth, 0, 0, 0,
    // 0, -2 * resolutionScale / canvasHeight, 0, 0,
    0, -2 * resolutionScale / mapHeight, 0, 0,
    0, 0, 0, 0,
    -1, 1, 0, 1
  ]);
};

/**
 * Renders the points based on the current view. Do not call directly; instead,
 * scheduleUpdate() to have it be called in next turn of requestAnimationFrame.
 * @private
 */
PointMap.prototype.update_ = function() {
  var gl = this.gl_;
  var pointProgram = this.pointProgram_;

  gl.clear(gl.COLOR_BUFFER_BIT);

  var mapProjection = this.map_.getProjection();

  // copy pixel->webgl matrix
  this.mapMatrix_.set(this.pixelsToWebGLMatrix_);

  // Scale to current zoom (worldCoords * 2^zoom)
  var scale = Math.pow(2, this.map_.getZoom());
  PointMap.scaleMatrix_(this.mapMatrix_, scale, scale);

  // translate to current view (vector from topLeft to 0,0)
  var offset = mapProjection.fromLatLngToPoint(this.canvasLayer_.getTopLeft());
  PointMap.translateMatrix_(this.mapMatrix_, -offset.x, -offset.y);

  // TODO(bckenny): if we only have one buffer, could bind once
  gl.bindBuffer(gl.ARRAY_BUFFER, this.pointArrayBuffer_);
  gl.vertexAttribPointer(pointProgram.attributes.worldCoord, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, this.colorArrayBuffer_);
  gl.vertexAttribPointer(pointProgram.attributes.aVertexColor, 4, gl.FLOAT, false, 0, 0);

  //var pointSize = this.pointScale_ * this.resolutionScale_ * scale;
  var pointSize = this.pointScale_ * 200 * this.resolutionScale_ * Math.pow(scale, 0.4);
  pointProgram.uniforms.pointSize(pointSize);
  pointProgram.uniforms.pointAlpha(this.globalAlpha_);
  pointProgram.uniforms.mapMatrix(this.mapMatrix_);

  // draw!
  gl.drawArrays(gl.POINTS, 0, this.pointCount_);
};
