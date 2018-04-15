import indexFromEnd from '../utils/array/indexFromEnd';
import arrayFrom from '../utils/array/arrayFrom';
import isObject from '../utils/object/isObject';
import orderBy from 'lodash.orderby';
import KeyEventBitmapManager from './KeyEventBitmapManager';
import normalizeKeyName from './normalizeKeyName';
import KeySerializer from './KeySerializer';
import KeyEventBitmapIndex from '../const/KeyEventBitmapIndex';
import ignoreEventsCondition from './ignoreEventsCondition';
import isEmpty from '../utils/collection/isEmpty';

/**
 * Provides a registry for keyboard sequences and events, and the handlers that should
 * be called when they are detected. Also contains the interface for processing and
 * matching keyboard events against its list of registered actions and handlers.
 * @class
 */
class KeyEventManager {
  /**
   * Creates a new KeyEventManager instance if one does not already exist, or allows
   * accessing existing instances via their id. This method is intended to normally
   * only generate one instance at a time and return it once the existence exists (a
   * Singleton) but can also be forced to create a new instance when another is required
   * to allow unfinished event propagation to resolve itself later.
   * @param {Number=} instanceId Id of the (non-newest) KeyEventManager to return
   * @param options Options Object
   * @param {Boolean=} options.forceNew Whether to force the creation of a new KeyEventManager
   *        instance rather than returning the newest one
   * @returns {KeyEventManager} The newest instance, or the one with the specified id
   */
  static getInstance(instanceId, options={}) {
    if (!this.instanceId) {
      this.instanceId = 0;
      this.instances = {};
    }

    if (!this.instanceId || options.forceNew) {
      this.instanceId += 1;
      this.instances[this.instanceId] = new KeyEventManager(this.instanceId);
    }

    return this.instances[instanceId || this.instanceId];
  }

  static clear(instanceId) {
    if (instanceId) {
      delete this.instances[instanceId];
    } else {
      this.instances = {};
      this.instanceId = 0;
    }
  }

  /**
   * Creates a new KeyEventManager instance. It is expected that only a single instance
   * will be used with a render tree.
   */
  constructor(instanceId) {
    this.instanceId = instanceId;

    this._reset();
  }

  /**
   * Clears the internal state, wiping and history of key events and registered handlers
   * so they have no effect on the next tree of focused HotKeys components
   * @private
   */
  _reset() {
    if (!this.flags || !this.flags.reset) {
      /**
       * @typedef {Object} ComponentOptions Object containing a description of the key map
       *          and handlers from a particular HotKeys component
       * @property {KeyEventMatcher} keyMatchersMap Map of ActionNames to
       *           KeySequenceDSLStatement
       * @property {EventHandlerMap} handlers Map of ActionNames to EventHandlers
       */

      /**
       * List of actions and handlers registered by each component currently in focus.
       * The component closest to the element in focus is last in the list.
       * @type {ComponentOptions[]}
       */
      this.componentList = [];

      /**
       * @typedef {String} KeyName Name of the keyboard key
       */

      /**
       * @typedef {Number} ComponentIndex Unique index associated with every HotKeys component
       * as it registers itself as being in focus. The HotKeys component closest to the DOM
       * element in focus gets the smallest number (0) and those further up the render tree
       * get larger (incrementing) numbers.
       */

      /**
       * @typedef {Object} BasicKeyCombination Object containing the basic information that
       *          describes a key combination
       * @property {KeyCombinationId} id String description of keys involved in the key
       *          combination
       * @property {Number} size Number of keys involved in the combination
       * @property {Object.<KeyName, Boolean>} keyDictionary Dictionary of key names involved in
       *           the key combination
       */

      /**
       * @typedef {Object} KeySequenceObject Object containing description of a key sequence
       *          to compared against key events
       * @property {KeySequenceId} id Id describing key sequence used for matching against
       *            key events
       * @property {ComponentIndex} componentIndex Id associated with the HotKeys component
       *          that registered the key sequence
       * @property {BasicKeyCombination[]} sequence A list of key combinations involved in
       *            the sequence
       * @property {Number} size Number of key combinations in the key sequence
       * @property {KeyEventBitmapIndex} eventBitmapIndex Index that matches key event type
       * @property {ActionName} actionName Name of the action that should be triggered if a
       *           keyboard event matching the sequence and event type occur
       */

      /**
       * @typedef {Object} KeyCombinationObject Object containing description of a key
       *          combination to compared against key events
       * @extends BasicKeyCombination
       * @property {ComponentIndex} componentIndex Id associated with the HotKeys component
       *          that registered the key sequence
       * @property {Number} size Number of key combinations in the key sequence
       * @property {KeyEventBitmapIndex} eventBitmapIndex Index that matches key event type
       * @property {ActionName} actionName Name of the action that should be triggered if a
       *           keyboard event matching the combination and event type occur
       */

      /**
       * @typedef {Object} KeyEventMatcher Object containing key sequence and combination
       *          descriptions for a particular HotKeys component
       * @property {KeySequenceObject} sequences Map of key sequences
       * @property {KeyCombinationObject} combinations Map of key combinations
       * @property {KeyCombinationId[]} combinationsOrder Order of combinations from highest
       *            priority to lowest
       */

      /**
       * Counter for the longest sequence registered by the HotKeys components currently
       * in focus. Allows setting an upper bound on the length of the key event history
       * that must be kept.
       * @type {Number}
       */
      this.longestKeySequence = 1;

      /**
       * Bitmap to record whether there is at least one keymap bound to each event type
       * (keydown, keypress or keyup) so that we can skip trying to find a matching keymap
       * on events where we know there is none to find
       * @type {KeyEventBitmap}
       */
      this.keyMapEventBitmap = KeyEventBitmapManager.newBitmap();

      /**
       * Container of flags that keep track of various facets of the KeyEventManager's
       * state.
       * @type {{reset: boolean, keyStateIncludesKeyUp: boolean}}
       */
      this.flags = {
        /**
         * Whether the KeyEventManager has been reset - sets to false when new HotKeys
         * components start registering themselves as being focused
         */
        reset: true,

        /**
         * Whether the current key combination includes at least one keyup event - indicating
         * that the current combination is ending (and keys are being released)
         */
        keyCombinationIncludesKeyUp: false,
      };

      /**
       * @typedef {Object.<String, KeyEventBitmap[]>} KeyCombinationRecord A dictionary of keys that
       * have been pressed down at once. The keys of the map are the lowercase names of the
       * keyboard keys. May contain 1 or more keyboard keys.
       *
       * @example: A key combination for when shift and A have been pressed, but not released:
       *
       * {
       *   shift: [ [true,false,false], [true,true,false] ],
       *   A: [ [true,true,false], [true,true,false] ]
       * }
       *
       * List of most recent key combinations seen by the KeyEventManager
       * @type {KeyCombinationRecord[]}
       */
      this.keyCombinationHistory = [];

      this._clearEventPropagationState();
    }
  }

  /**
   * Clears the history that is maintained for the duration of a single keyboard event's
   * propagation up the React component tree towards the root component, so that the
   * next keyboard event starts with a clean state.
   * @private
   */
  _clearEventPropagationState() {
    /**
     * Object containing state of a key events propagation up the render tree towards
     * the document root
     * @type {{previousComponentIndex: number, actionHandled: boolean}}}
     */
    this.eventPropagationState = {
      /**
       * Index of the component last seen to be handling a key event
       * @type {ComponentIndex}
       */
      previousComponentIndex: 0,

      /**
       * Whether the keyboard event currently being handled has already matched a
       * handler function that has been called
       * @type {Boolean}
       */
      actionHandled: false,

      /**
       * Whether the keyboard event current being handled should be ignored
       * @type {Boolean}
       */
      ignoreEvent: false,
    };
  }

  /**
   * @typedef {String} ActionName Unique identifier of an action that is used to match
   *          against handlers when a matching keyboard event occurs
   */

  /**
   * @typedef {Object.<KeySequenceId, KeyEventMatcher>} KeyMap A mapping from key
   * sequence ids to key event matchers
   */

  /**
   * @typedef {String} KeyCombinationId String describing a combination of one or more
   * keys separated by '+'
   */

  /**
   * @typedef {String} KeySequenceId String describing a sequence of one or more key
   * combinations with whitespace separating key combinations in the sequence and '+'
   * separating keys within a key combination.
   */

  /**
   * @typedef {KeySequenceId|KeyCombinationId|KeySequenceId[]|KeyCombinationId[]} KeyEventExpression
   *          expression describing a keyboard event
   */

  /**
   * @typedef {Object.<ActionName, KeyEventExpression>} ActionKeyMap Mapping of ActionNames
   *          to KeyEventExpressions
   */

  /**
   * @typedef {Function(KeyboardEvent)} EventHandler Handler function that is called
   *          with the matching keyboard event
   */

  /**
   * @typedef {Object<ActionName, EventHandler>} EventHandlerMap Mapping of ActionNames
   *          to EventHandlers
   */

  /**
   * Registers the actions and handlers of a HotKeys component that has gained focus
   * @param {ActionKeyMap} actionNameToKeyMap Map of actions to key expressions
   * @param {EventHandlerMap} actionNameToHandlersMap Map of actions to handler functions
   * @returns {ComponentIndex} Unique component index to assign to the focused HotKeys
   *         component and passed back when handling a key event
   */
  handleFocus(actionNameToKeyMap = {}, actionNameToHandlersMap = {}) {
    if (this.flags.reset) {
      this.flags.reset = false;
    }

    const componentIndex = this.componentList.length;

    const { keyMap: hardSequenceKeyMap, handlers } = this._applyHardSequences(componentIndex, actionNameToKeyMap, actionNameToHandlersMap);

    const { keyMatcher, eventBitmap, longestSequence } = this._buildKeyMatcherMap({ ...actionNameToKeyMap, ...hardSequenceKeyMap }, componentIndex);

    this.componentList.unshift({
      keyMatcher,
      eventBitmap,
      longestSequence,
      handlers
    });

    return componentIndex;
  }

  _applyHardSequences(componentIndex, actionNameToKeyMap, actionNameToHandlersMap) {
    let counter = 0;

    return Object.keys(actionNameToHandlersMap).reduce((memo, actionNameOrKeyExpression) => {
      const actionNameIsInKeyMap = !!actionNameToKeyMap[actionNameOrKeyExpression];

      const handler = actionNameToHandlersMap[actionNameOrKeyExpression];

      if (!actionNameIsInKeyMap && KeySerializer.isValidKeySerialization(actionNameOrKeyExpression)) {
        const implicitActionName = `Component${componentIndex}HardSequence${counter++}`;

        memo.keyMap[implicitActionName] = actionNameOrKeyExpression;
        memo.handlers[implicitActionName] = handler;
      } else {
        memo.handlers[actionNameOrKeyExpression] = handler;
      }

      return memo;
    }, { keyMap: {}, handlers: {}});
  }

  /**
   * @typedef {Object} KeyExpressionObject Object describing a key event
   * @property {KeySequenceId|KeyCombinationId|KeySequenceId[]|KeyCombinationId[]} sequence
   * @property {EventType} action
   */

  /**
   * Converts a ActionKeyMap to a KeyExpressionObject and saves it so it can later be
   * recalled and matched against key events
   * @param {ActionKeyMap} actionNameToKeyMap Mapping of ActionNames to key sequences
   * @param {ComponentIndex} componentIndex Index of component registering the keyMap
   * @return {KeyEventMatcher}
   * @private
   */
  _buildKeyMatcherMap(actionNameToKeyMap, componentIndex) {
    const eventBitmap = KeyEventBitmapManager.newBitmap();
    let longestSequence = 1;

    const keyMatcher = Object.keys(actionNameToKeyMap).reduce((keyMapMemo, actionName) => {
      const keyMapOptions = arrayFrom(actionNameToKeyMap[actionName]);

      keyMapOptions.forEach((keyMapOption) => {
        const { keySequence, eventBitmapIndex } = function(){
          if (isObject(keyMapOption)) {
            const { sequence, action } = keyMapOption;

            return {
              keySequence: sequence,
              eventBitmapIndex: KeyEventBitmapIndex[action]
            };
          } else {
            return {
              keySequence: keyMapOption,
              eventBitmapIndex: KeyEventBitmapIndex.keypress
            }
          }
        }();

        const { sequence, combination } = KeySerializer.parseString(keySequence, { eventBitmapIndex });

        if (sequence.size > this.longestKeySequence) {
          this.longestKeySequence = sequence.size;
        }

        if (sequence.size > longestSequence) {
          longestSequence = sequence.size;
        }

        /**
         * Record that there is at least one key sequence in the focus tree bound to
         * the keyboard event
         */
        this.keyMapEventBitmap[eventBitmapIndex] = true;

        /**
         * Record that there is at least one key sequence in the current component's
         * keymap bound to the keyboard event
         */
        eventBitmap[eventBitmapIndex] = true;

        if (!keyMapMemo[sequence.prefix]) {
          keyMapMemo[sequence.prefix] = { combinations: {} };
        }

        keyMapMemo[sequence.prefix].combinations[combination.id] = {
          ...combination,
          actionName
        };
      });

      return keyMapMemo;
    }, {});

    Object.keys(keyMatcher).forEach((sequencePrefix) => {
      keyMatcher[sequencePrefix].order = orderBy(Object.values(keyMatcher[sequencePrefix].combinations), ['size'], ['desc']).map(({id}) => id)
    });

    return { keyMatcher, eventBitmap, longestSequence };
  }

  /**
   * Handles when a component loses focus by resetting the internal state, ready to
   * receive the next tree of focused HotKeys components
   * @returns {Number|void} The KeyEventManager's instance id if there are still pending
   *        event propagation to occur so the calling HotKeys component can request
   *        the correct instance to finish that propagation off.
   */
  handleBlur(){
    this._checkForPendingPropagation();

    this._reset();

    if (this.pendingPropagation) {
      return this.instanceId;
    }
  }

  _checkForPendingPropagation() {
    if (typeof this.pendingPropagation === 'undefined') {
      this.pendingPropagation = this.eventPropagationState.previousComponentIndex < this.componentList.length -1;
    }

    return this.pendingPropagation;
  }

  /**
   * Records a keydown keyboard event and matches it against the list of pre-registered
   * event handlers, calling the first matching handler with the highest priority if
   * one exists.
   *
   * This method is called many times as a keyboard event bubbles up through the React
   * render tree. The event is only registered the first time it is seen and results
   * of some calculations are cached. The event is matched against the handlers registered
   * at each component level, to ensure the proper handler declaration scoping.
   * @param {KeyboardEvent} event Event containing the key name and state
   * @param {ComponentIndex} componentIndex The index of the component that is currently handling
   *        the keyboard event as it bubbles towards the document root.
   */
  handleKeyDown(event, componentIndex) {
    if (this._shouldIgnoreEvent()) {
      this._updateEventPropagationHistory(componentIndex);
      return;
    }

    const _key = normalizeKeyName(event.key);

    if (this._isNewKeyEvent(componentIndex)) {
      /**
       * We know that this is a new key event and not the same event bubbling up
       * the React render tree towards the document root, so perform actions specific
       * to the first time an event is seen
       */

      this._setIgnoreEventFlag(event);

      if (this._shouldIgnoreEvent()) {
        this._updateEventPropagationHistory(componentIndex);
        return;
      }

      const keyInCurrentCombination = !!this._getCurrentKeyCombination().keys[_key];


      if (keyInCurrentCombination || this.flags.keyCombinationIncludesKeyUp) {
        this._startNewKeyCombination(_key, KeyEventBitmapIndex.keydown);
      } else {
        this._addToCurrentKeyCombination(_key, KeyEventBitmapIndex.keydown);
      }
    }

    this._callHandlerIfActionNotHandled(event, _key, KeyEventBitmapIndex.keydown, componentIndex);

    this._updateEventPropagationHistory(componentIndex);
  }

  /**
   * Records a keypress keyboard event and matches it against the list of pre-registered
   * event handlers, calling the first matching handler with the highest priority if
   * one exists.
   *
   * This method is called many times as a keyboard event bubbles up through the React
   * render tree. The event is only registered the first time it is seen and results
   * of some calculations are cached. The event is matched against the handlers registered
   * at each component level, to ensure the proper handler declaration scoping.
   * @param {KeyboardEvent} event Event containing the key name and state
   * @param {ComponentIndex} componentIndex The index of the component that is currently handling
   *        the keyboard event as it bubbles towards the document root.
   */
  handleKeyPress(event, componentIndex) {

    if (this._shouldIgnoreEvent()) {
      this._updateEventPropagationHistory(componentIndex);
      return;
    }

    const _key = normalizeKeyName(event.key);

    if (this._isNewKeyEvent(componentIndex)) {
      /**
       * We know that this is a new key event and not the same event bubbling up
       * the React render tree towards the document root, so perform actions specific
       * to the first time an event is seen
       */

      this._setIgnoreEventFlag(event);

      if (this._shouldIgnoreEvent()) {
        this._updateEventPropagationHistory(componentIndex);
        return;
      }

      /**
       * Add new key event to key combination history
       */

      const keyCombination = this._getCurrentKeyCombination().keys[_key];
      const alreadySeenKeyInCurrentCombo = keyCombination && (keyCombination[KeyEventBitmapIndex.current][KeyEventBitmapIndex.keypress] || keyCombination[KeyEventBitmapIndex.current][KeyEventBitmapIndex.keyup]);

      if (alreadySeenKeyInCurrentCombo) {
        this._startNewKeyCombination(_key, KeyEventBitmapIndex.keypress)
      } else {
        this._addToCurrentKeyCombination(_key, KeyEventBitmapIndex.keypress);
      }
    }

    this._callHandlerIfActionNotHandled(event, _key, KeyEventBitmapIndex.keypress, componentIndex);

    this._updateEventPropagationHistory(componentIndex);
  }

  /**
   * Records a keyup keyboard event and matches it against the list of pre-registered
   * event handlers, calling the first matching handler with the highest priority if
   * one exists.
   *
   * This method is called many times as a keyboard event bubbles up through the React
   * render tree. The event is only registered the first time it is seen and results
   * of some calculations are cached. The event is matched against the handlers registered
   * at each component level, to ensure the proper handler declaration scoping.
   * @param {KeyboardEvent} event Event containing the key name and state
   * @param {ComponentIndex} componentIndex The index of the component that is currently handling
   *        the keyboard event as it bubbles towards the document root.
   * @return {Number} Length of component list so calling HotKeys component can establish
   *        if it's the last one in the list, or not
   */
  handleKeyUp(event, componentIndex) {
    if (this._shouldIgnoreEvent()) {
      this._updateEventPropagationHistory(componentIndex);
      return;
    }

    const _key = normalizeKeyName(event.key);

    if (this._isNewKeyEvent(componentIndex)) {
      /**
       * We know that this is a new key event and not the same event bubbling up
       * the React render tree towards the document root, so perform actions specific
       * to the first time an event is seen
       */

      this._setIgnoreEventFlag(event);

      if (this._shouldIgnoreEvent()) {
        this._updateEventPropagationHistory(componentIndex);
        return;
      }

      const keyCombination = this._getCurrentKeyCombination().keys[_key];

      const alreadySeenKeyInCurrentCombo = keyCombination && keyCombination[KeyEventBitmapIndex.current][KeyEventBitmapIndex.keyup];

      if (alreadySeenKeyInCurrentCombo) {
        this._startNewKeyCombination(_key, KeyEventBitmapIndex.keyup);
      } else {
        this._addToCurrentKeyCombination(_key, KeyEventBitmapIndex.keyup);

        this.flags.keyCombinationIncludesKeyUp = true;
      }
    }

    this._callHandlerIfActionNotHandled(event, _key, KeyEventBitmapIndex.keyup, componentIndex);

    this._updateEventPropagationHistory(componentIndex);

    return this.componentList.length;
  }

  _updateEventPropagationHistory(componentIndex) {
    if (this._isFocusTreeRoot(componentIndex)) {
      this._clearEventPropagationState();
    } else {
      this.eventPropagationState.previousComponentIndex = componentIndex;
    }
  }

  _isFocusTreeRoot(componentIndex) {
    return componentIndex >= this.componentList.length - 1;
  }

  /**
   * @callback ignoreEventsConditionCallback
   * @param {KeyboardEvent) event Keyboard event
   * @return {Boolean} Whether to ignore the event
   */
  /**
   * Sets the function used to determine whether a keyboard event should be ignored.
   *
   * The function passed as an argument accepts the KeyboardEvent as its only argument.
   * @param {ignoreEventsConditionCallback} func Function to use to decide whether to
   *        ignore keyboard events
   */
  static setIgnoreEventsCondition(func){
    this.ignoreEventsCondition = func;
  }

  /**
   * Sets the ignoreEventsCondition function back to its original value
   */
  static resetIgnoreEventsCondition(){
    this.ignoreEventsCondition = ignoreEventsCondition;
  }

  /**
   * Whether to ignore a particular keyboard event
   * @param {KeyboardEvent} event Event that must be decided to ignore or not
   * @returns {Boolean} Whether to ignore the keyboard event
   */
  static ignoreEventsCondition(event) {
    return ignoreEventsCondition(event)
  }

  /**
   * Sets the ignoreEvent flag so that subsequent handlers of the same event
   * do not have to re-evaluate whether to ignore the event or not as it bubbles
   * up towards the document root
   * @param {KeyboardEvent} event The event to decide whether to ignore
   * @private
   */
  _setIgnoreEventFlag(event) {
    this.eventPropagationState.ignoreEvent = this.constructor.ignoreEventsCondition(event);
  }

  /**
   * Whether KeyEventManager should ignore the event that is currently being handled
   * @returns {Boolean} Whether to ignore the event
   *
   * Do not override this method. Use setIgnoreEventsCondition() instead.
   * @private
   */
  _shouldIgnoreEvent() {
    return this.eventPropagationState.ignoreEvent;
  }

  /**
   * Returns whether this is a previously seen event bubbling up to render tree towards
   * the document root, or whether it is a new event that has not previously been seen.
   * @param {ComponentIndex} componentIndex Index of the component currently handling
   *        the keyboard event
   * @return {Boolean} If the event has been seen before
   * @private
   */
  _isNewKeyEvent(componentIndex) {
    return this.eventPropagationState.previousComponentIndex >= componentIndex;
  }

  /**
   * Returns the current key combination, i.e. the key combination that represents
   * the current key events.
   * @returns {KeyCombinationRecord} The current key combination
   * @private
   */
  _getCurrentKeyCombination() {
    if (this.keyCombinationHistory.length > 0) {
      return this.keyCombinationHistory[this.keyCombinationHistory.length - 1];
    } else {
      return { keys: {}, id: '' };
    }
  }

  /**
   * Adds a key event to the current key combination (as opposed to starting a new
   * keyboard combination).
   * @param {String} keyName Name of the key to add to the current combination
   * @param {KeyEventBitmapIndex} bitmapIndex Index in bitmap to set to true
   * @private
   */
  _addToCurrentKeyCombination(keyName, bitmapIndex) {
    if (this.keyCombinationHistory.length === 0) {
      this.keyCombinationHistory.push({ keys: {}, id: '' });
    }

    const keyCombination = this._getCurrentKeyCombination();

    const existingBitmap = keyCombination.keys[keyName];

    if (!existingBitmap) {
      keyCombination.keys[keyName] = [
        KeyEventBitmapManager.newBitmap(),
        KeyEventBitmapManager.newBitmap(bitmapIndex)
      ];

    } else {
      delete keyCombination.keys[keyName][0];

      keyCombination.keys[keyName] = [
        KeyEventBitmapManager.clone(existingBitmap[1]),
        KeyEventBitmapManager.setBit(existingBitmap[1], bitmapIndex),
      ];
    }

    keyCombination.id = KeySerializer.sequence(keyCombination.keys);
  }

  /**
   * Adds a new KeyCombinationRecord to the event history and resets the keystateIncludesKeyUp
   * flag to false.
   * @param {String} keyName Name of the keyboard key to add to the new KeyCombinationRecord
   * @param {KeyEventBitmapIndex} eventBitmapIndex Index of bit to set to true in new
   *        KeyEventBitmap
   * @private
   */
  _startNewKeyCombination(keyName, eventBitmapIndex) {
    if (this.keyCombinationHistory.length > this.longestKeySequence) {
      /**
       * We know the longest key sequence registered for the currently focused
       * components, so we don't need to keep a record of history longer than
       * that
       */
      this.keyCombinationHistory.shift();
    }

    const lastKeyCombination = this._getCurrentKeyCombination();

    const keys = {
      ...this._withoutKeyUps(lastKeyCombination),
      [keyName]: [
        KeyEventBitmapManager.newBitmap(),
        KeyEventBitmapManager.newBitmap(eventBitmapIndex)
      ]
    };

    this.keyCombinationHistory.push({
      keys,
      id: KeySerializer.sequence(keys)
    });

    this.flags.keyCombinationIncludesKeyUp = false;
  }

  /**
   * Returns a new KeyCombinationRecord without the keys that have been
   * released (had the keyup event recorded). Essentially, the keys that are
   * currently still pressed down at the time a key event is being handled.
   * @param {KeyCombinationRecord} keyCombinationRecord Record of keys currently
   *        pressed down that should have the release keyed omitted from
   * @returns {KeyCombinationRecord} New KeyCombinationRecord with all of the
   *        keys with keyup events omitted
   * @private
   */
  _withoutKeyUps(keyCombinationRecord) {
    return Object.keys(keyCombinationRecord.keys).reduce((memo, keyName) => {
      const keyState = keyCombinationRecord.keys[keyName];

      if (!keyState[KeyEventBitmapIndex.current][KeyEventBitmapIndex.keyup]) {
        memo[keyName] = keyState;
      }

      return memo;
    }, {});
  }

  /**
   * Calls the first handler that matches the current key event if the action has not
   * already been handled in a more deeply nested component
   * @param {KeyboardEvent} event Keyboard event object to be passed to the handler
   * @param {NormalizedKeyName} keyName Normalized key name
   * @param {KeyEventBitmapIndex} eventBitmapIndex The bitmap index of the current key event type
   * @param {ComponentIndex} componentIndex Index of the component that is currently handling
   *        the keyboard event
   * @private
   */
  _callHandlerIfActionNotHandled(event, keyName, eventBitmapIndex, componentIndex) {
    if (this.keyMapEventBitmap[eventBitmapIndex] && !this.eventPropagationState.actionHandled) {
      this._callMatchingHandlerClosestToEventTarget(event, keyName, eventBitmapIndex, componentIndex);
    }
  }

  _callMatchingHandlerClosestToEventTarget(event, keyName, eventBitmapIndex, componentIndex) {
    /**
     * @type {KeyEventMatcher}
     */
    const componentOptions = indexFromEnd(this.componentList, componentIndex);

    if (!componentOptions || isEmpty(componentOptions.keyMatcher) || !componentOptions.eventBitmap[eventBitmapIndex]) {
      /**
       * Component doesn't define any matchers for the current key event
       */
      return;
    }

    const { keyMatcher, longestSequence } = componentOptions;

    const currentKeyState = this._getCurrentKeyCombination();

    let counter = longestSequence;

    while(counter >= 0) {
      const sequenceHistory = this.keyCombinationHistory.slice(-counter, -1);
      const sequenceId = sequenceHistory.map(({ id }) => id ).join(' ');

      const matchingSequence = keyMatcher[sequenceId];

      if (matchingSequence) {
        let combinationIndex = 0;

        const combinationOrder = matchingSequence.order;

        while(combinationIndex < combinationOrder.length) {
          const combinationId = combinationOrder[combinationIndex];
          const combinationMatcher = matchingSequence.combinations[combinationId];

          if (this._combinationMatchesKeys(keyName, currentKeyState, combinationMatcher)) {
            const handler = this._getMatchingHandlerClosestToEventTarget(combinationMatcher.actionName, componentIndex);

            if (handler) {
              handler(event);
              this.eventPropagationState.actionHandled = true;

              return;
            }
          }

          combinationIndex++;
        }

      }

      counter--;
    }
  }

  _combinationMatchesKeys(keyName, keyHistory, combinationMatch) {
    let keyCompletesCombination = false;

    const combinationMatchesKeysPressed = !Object.keys(combinationMatch.keyDictionary).some((candidateKeyName) => {
      const candidateBitmapIndex = combinationMatch.eventBitmapIndex;

      const keyEventBitmap = keyHistory.keys[candidateKeyName];

      if (keyEventBitmap) {
        const keyEventBitTrue = keyEventBitmap[KeyEventBitmapIndex.current][candidateBitmapIndex];

        if (keyName && candidateKeyName === keyName) {
          keyCompletesCombination = !keyEventBitmap[KeyEventBitmapIndex.previous][candidateBitmapIndex] && keyEventBitTrue;
        }

        return !keyEventBitTrue;
      } else {
        return true;
      }
    });

    return combinationMatchesKeysPressed && keyCompletesCombination;
  }

  /**
   * Returns the highest priority handler function registered to the specified action,
   * if one exists
   * @param {ActionName} actionName Name of the action to find the handler for
   * @param {ComponentIndex} componentIndex Index of the component to start looking
   *        for handlers
   * @returns {EventHandler} Highest priority handler function that matches the action
   * @private
   */
  _getMatchingHandlerClosestToEventTarget(actionName, componentIndex) {
    let counter = 0;

    while(counter <= componentIndex) {
      /**
       * @type {ComponentOptions}
       */
      const { handlers } = indexFromEnd(this.componentList, counter);
      const handler = handlers[actionName];

      if (handler) {
        return handler;
      }

      counter++;
    }

    return null;
  }
}

export default KeyEventManager;