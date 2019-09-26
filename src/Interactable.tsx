import React from "react";
import { StyleProp, ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import {
  PanGestureHandler,
  PanGestureHandlerGestureEvent,
  PanGestureHandlerStateChangeEvent,
  State,
} from "react-native-gesture-handler";
import {
  sq,
  clamp,
  anchorObject,
  bounceObject,
  frictionObject,
  gravityObject,
  influenceXY,
  springObject,
  AnimatedAdaptableXY,
  AnimatedNodeXY,
  AnimatedObject,
  AnimatedValueXY,
  Behavior,
  BehaviorXY,
  BoundaryXY,
} from "@tleef/react-native-reanimated-utils/lib";

const {
  Value,
  Clock,
  event,
  call,
  block,
  set,
  diff,
  cond,
  and,
  eq,
  greaterOrEq,
  lessThan,
  abs,
  add,
  sub,
  multiply,
  divide,
  clockRunning,
  startClock,
  stopClock,
} = Animated;

const ANIMATOR_PAUSE_CONSECUTIVE_FRAMES = 10;
const ANIMATOR_PAUSE_ZERO_VELOCITY = 1;

const DEFAULT = {
  snapPoint: {
    x: 0,
    y: 0,
    tension: 300,
    damping: 0.7,
  },
  gravityPoint: {
    x: 0,
    y: 0,
    strength: 400,
    falloff: 40,
  },
  boundaries: {
    bounce: 0,
  },
  dragEnabled: true,
  dragWithSpring: {
    damping: 0.7,
  },
  dragToss: 0.1,
  initialPosition: {
    x: 0,
    y: 0,
  },
};

interface PrioritizedBehaviorXY {
  priority: number;
  behavior: BehaviorXY;
}

interface BehaviorsXY {
  x: Behavior[];
  y: Behavior[];
}

interface Point {
  x: number;
  y: number;
}

interface SpringConfig {
  tension: number;
  damping?: number;
}

interface Area {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

interface Boundaries extends Area {
  bounce?: number;
  haptics?: boolean;
}

interface FrictionArea {
  damping?: number;
  influenceArea?: Area;
  haptics?: boolean;
}

interface SnapPoint extends Partial<SpringConfig>, Partial<Point> {
  id?: string;
}

interface AnimatedSnapPoint {
  x: Animated.Value<number>;
  y: Animated.Value<number>;
  tension: Animated.Value<number>;
  damping: Animated.Value<number>;
}

interface SpringPoint
  extends FrictionArea,
    Partial<SpringConfig>,
    Partial<Point> {}

interface GravityPoint extends FrictionArea, Partial<Point> {
  strength?: number;
  falloff?: number;
}

interface SnapEvent {
  nativeEvent: {
    index: number;
    id?: string;
  };
}

interface StopEvent {
  nativeEvent: {
    x: number;
    y: number;
  };
}

interface DragEvent {
  nativeEvent: {
    state: "start" | "end";
    x: number;
    y: number;
    targetSnapPointId?: string;
  };
}

type DragCallback = (event: DragEvent) => void;
type StopCallback = (event: StopEvent) => void;
type SnapCallback = (event: SnapEvent) => void;

interface Props {
  snapPoints: SnapPoint[]; // required
  springPoints?: SpringPoint[];
  gravityPoints?: GravityPoint[];
  frictionAreas?: FrictionArea[];
  horizontalOnly?: boolean;
  verticalOnly?: boolean;
  boundaries?: Boundaries;
  onSnap?: SnapCallback;
  onStop?: StopCallback;
  onDrag?: DragCallback;
  dragEnabled: boolean; // has default
  dragWithSpring?: SpringConfig;
  dragToss: number; // has default
  animatedValueX?: Animated.Value<number>;
  animatedValueY?: Animated.Value<number>;
  initialPosition: Partial<Point>; // has default
  style: StyleProp<ViewStyle>;
}

export default class Interactable extends React.PureComponent<Props> {
  private readonly _object: AnimatedObject;
  private readonly _snapPoint: AnimatedSnapPoint;
  private readonly _dragging: AnimatedValueXY<0 | 1>;
  private readonly _transX: Animated.Node<number>;
  private readonly _transY: Animated.Node<number>;
  private readonly _onGestureEvent: (
    event: PanGestureHandlerGestureEvent | PanGestureHandlerStateChangeEvent,
  ) => void;

  static defaultProps = {
    dragEnabled: DEFAULT.dragEnabled,
    dragToss: DEFAULT.dragToss,
    initialPosition: DEFAULT.initialPosition,
  };

  constructor(props: Props) {
    super(props);

    const clock = new Clock();
    const dt = divide(diff(clock), 1000);

    const state = new Value(-1);
    const gesture: AnimatedValueXY<number> = {
      x: new Value(0),
      y: new Value(0),
    };

    const dragAnchor: AnimatedValueXY<number> = {
      x: new Value(0),
      y: new Value(0),
    };

    const prioritizedPermBehaviors: PrioritizedBehaviorXY[] = [];
    const prioritizedDragBehaviors: PrioritizedBehaviorXY[] = [];
    const prioritizedSnapBehaviors: PrioritizedBehaviorXY[] = [];

    // Exposed values
    // Useful for driving other animations
    const exposed: Partial<AnimatedValueXY<number>> = {
      x: props.animatedValueX,
      y: props.animatedValueY,
    };

    this._onGestureEvent = event([
      {
        nativeEvent: {
          translationX: gesture.x,
          translationY: gesture.y,
          state: state,
        },
      },
    ]);

    this._object = {
      x: new Value(props.initialPosition.x || DEFAULT.initialPosition.x),
      y: new Value(props.initialPosition.y || DEFAULT.initialPosition.y),
      vx: new Value(0),
      vy: new Value(0),
      mass: 1,
    };

    this._snapPoint = {
      x: new Value(props.initialPosition.x || DEFAULT.initialPosition.x),
      y: new Value(props.initialPosition.y || DEFAULT.initialPosition.y),
      tension: new Value(DEFAULT.snapPoint.tension),
      damping: new Value(DEFAULT.snapPoint.damping),
    };

    this._dragging = {
      x: new Value(0),
      y: new Value(0),
    };

    if (props.dragWithSpring) {
      const { tension, damping } = props.dragWithSpring;
      addSpring(
        this._object,
        dragAnchor,
        tension,
        dt,
        undefined,
        prioritizedDragBehaviors,
      );
      addFriction(
        this._object,
        damping || DEFAULT.dragWithSpring.damping,
        dt,
        undefined,
        prioritizedDragBehaviors,
      );
    } else {
      addBehavior(
        {
          priority: 0,
          behavior: anchorObject(this._object, {
            anchor: dragAnchor,
            dt,
          }),
        },
        prioritizedDragBehaviors,
      );
    }

    addSpring(
      this._object,
      this._snapPoint,
      this._snapPoint.tension,
      dt,
      undefined,
      prioritizedSnapBehaviors,
    );
    addFriction(
      this._object,
      this._snapPoint.damping,
      dt,
      undefined,
      prioritizedSnapBehaviors,
    );

    if (props.springPoints) {
      props.springPoints.forEach((pt) => {
        const anchor: AnimatedValueXY<number> = {
          x: new Value(pt.x || DEFAULT.snapPoint.x),
          y: new Value(pt.y || DEFAULT.snapPoint.y),
        };
        addSpring(
          this._object,
          anchor,
          pt.tension || DEFAULT.snapPoint.tension,
          dt,
          pt.influenceArea,
          prioritizedPermBehaviors,
        );
        if (pt.damping) {
          addFriction(
            this._object,
            pt.damping,
            dt,
            pt.influenceArea,
            prioritizedPermBehaviors,
          );
        }
      });
    }

    if (props.gravityPoints) {
      props.gravityPoints.forEach((pt) => {
        const falloff = pt.falloff || DEFAULT.gravityPoint.falloff;
        const anchor = {
          x: new Value(pt.x || DEFAULT.gravityPoint.x),
          y: new Value(pt.y || DEFAULT.gravityPoint.y),
        };
        addGravity(
          this._object,
          anchor,
          pt.strength || DEFAULT.gravityPoint.strength,
          falloff,
          dt,
          pt.influenceArea,
          prioritizedPermBehaviors,
        );
        if (pt.damping) {
          const influenceArea =
            pt.influenceArea || influenceAreaFromRadius(pt, 1.4 * falloff);
          addFriction(
            this._object,
            pt.damping,
            dt,
            influenceArea,
            prioritizedPermBehaviors,
          );
        }
      });
    }

    if (props.frictionAreas) {
      props.frictionAreas.forEach((pt) => {
        if (pt.damping) {
          addFriction(
            this._object,
            pt.damping,
            dt,
            pt.influenceArea,
            prioritizedPermBehaviors,
          );
        }
      });
    }

    if (props.boundaries) {
      const boundary = areaToBoundaryXY(props.boundaries);
      if (boundary) {
        addBehavior(
          {
            priority: 0,
            behavior: bounceObject(this._object, {
              boundary,
              bounce: props.boundaries.bounce || DEFAULT.boundaries.bounce,
            }),
          },
          prioritizedSnapBehaviors,
        );
      }
    }

    // Merge drag/snap behaviors with perm behaviors in priority order then
    // unzip them to get a list of behaviors per axis
    const dragBehaviors = unzipBehaviors(
      mergeBehaviors(prioritizedDragBehaviors, prioritizedPermBehaviors),
    );
    const snapBehaviors = unzipBehaviors(
      mergeBehaviors(prioritizedSnapBehaviors, prioritizedPermBehaviors),
    );

    // Handle snap
    const tossTarget: AnimatedNodeXY<number> = {
      x: add(this._object.x, multiply(props.dragToss, this._object.vx)),
      y: add(this._object.y, multiply(props.dragToss, this._object.vy)),
    };

    const handleSnapTo = snapTo(
      tossTarget,
      props.snapPoints,
      this._snapPoint,
      props.onSnap,
      props.onDrag,
    );

    // Handle stop
    const noMovementFrames: AnimatedValueXY<number> = {
      x: new Value(
        props.verticalOnly ? ANIMATOR_PAUSE_CONSECUTIVE_FRAMES + 1 : 0,
      ),
      y: new Value(
        props.horizontalOnly ? ANIMATOR_PAUSE_CONSECUTIVE_FRAMES + 1 : 0,
      ),
    };

    const handleStop: Animated.Node<number>[] = [stopClock(clock)];

    if (props.onStop) {
      handleStop.unshift(
        cond(
          clockRunning(clock),
          call(
            [this._object.x, this._object.y],
            ([x, y]) => props.onStop && props.onStop({ nativeEvent: { x, y } }),
          ),
        ),
      );
    }

    const stopWhenNeeded = cond(
      and(
        greaterOrEq(noMovementFrames.x, ANIMATOR_PAUSE_CONSECUTIVE_FRAMES),
        greaterOrEq(noMovementFrames.y, ANIMATOR_PAUSE_CONSECUTIVE_FRAMES),
      ),
      handleStop,
      startClock(clock),
    );

    const trans = (
      axis: "x" | "y",
      vaxis: "vx" | "vy",
      lowerBound: "left" | "top",
      upperBound: "right" | "bottom",
    ) => {
      const start = new Value(0);
      const dragging = this._dragging[axis];
      const x = this._object[axis];
      const vx = this._object[vaxis];
      const anchor = dragAnchor[axis];
      const drag = gesture[axis];

      // Calculate advance
      let advance: Animated.Adaptable<number> = cond(
        lessThan(abs(vx), ANIMATOR_PAUSE_ZERO_VELOCITY),
        x,
        add(x, multiply(vx, dt)),
      );
      if (props.boundaries) {
        advance = clamp(
          advance,
          props.boundaries[lowerBound],
          props.boundaries[upperBound],
        );
      }

      // Check if obj is moving
      const last = new Value(Number.MAX_SAFE_INTEGER);
      const noMoveFrameCount = noMovementFrames[axis];
      const testMovementFrames = cond(
        eq(advance, last),
        set(noMoveFrameCount, add(noMoveFrameCount, 1)),
        [set(last, advance), set(noMoveFrameCount, 0)],
      );

      // Handle start
      const handleStartDrag: Animated.Node<number>[] = [
        startClock(clock),
        set(dragging, 1),
        set(start, x),
      ];

      if (props.onDrag) {
        handleStartDrag.unshift(
          call(
            [this._object.x, this._object.y],
            ([x, y]) =>
              props.onDrag &&
              props.onDrag({ nativeEvent: { x, y, state: "start" } }),
          ),
        );
      }

      // Handle step
      const step = cond(
        eq(state, State.ACTIVE),
        [
          cond(dragging, 0, handleStartDrag),
          set(anchor, add(start, drag)),
          cond(dt, dragBehaviors[axis]),
        ],
        [
          cond(dragging, [handleSnapTo, set(dragging, 0)]),
          cond(dt, snapBehaviors[axis]),
          testMovementFrames,
          stopWhenNeeded,
        ],
      );

      // Expose animatedValueX/animatedValueY
      const exposedAxis = exposed[axis];
      const doUpdateAnReturn = exposedAxis ? set(exposedAxis, x) : x;

      return block([step, set(x, advance), doUpdateAnReturn]);
    };

    this._transX = trans("x", "vx", "left", "right");
    this._transY = trans("y", "vy", "top", "bottom");
  }

  render() {
    const { children, style, horizontalOnly, verticalOnly } = this.props;
    return (
      <PanGestureHandler
        maxPointers={1}
        enabled={this.props.dragEnabled}
        onGestureEvent={this._onGestureEvent}
        onHandlerStateChange={this._onGestureEvent}
      >
        <Animated.View
          // @ts-ignore
          style={[
            style,
            {
              transform: [
                {
                  translateX: verticalOnly ? 0 : this._transX,
                  translateY: horizontalOnly ? 0 : this._transY,
                },
              ],
            },
          ]}
        >
          {children}
        </Animated.View>
      </PanGestureHandler>
    );
  }

  // imperative commands
  setVelocity({ x, y }: Partial<Point>) {
    if (x !== undefined) {
      this._dragging.x.setValue(1);
      this._object.vx.setValue(x);
    }
    if (y !== undefined) {
      this._dragging.y.setValue(1);
      this._object.vy.setValue(y);
    }
  }

  setPosition({ x, y }: Partial<Point>) {
    if (x !== undefined) {
      this._dragging.x.setValue(1);
      this._object.x.setValue(x);
    }
    if (y !== undefined) {
      this._dragging.x.setValue(1);
      this._object.y.setValue(y);
    }
  }

  snapTo({ index }: { index: number }) {
    const pt = this.props.snapPoints[index];
    this._snapPoint.tension.setValue(pt.tension || DEFAULT.snapPoint.tension);
    this._snapPoint.damping.setValue(pt.damping || DEFAULT.snapPoint.damping);
    this._snapPoint.x.setValue(pt.x || DEFAULT.snapPoint.x);
    this._snapPoint.y.setValue(pt.y || DEFAULT.snapPoint.y);
    this.props.onSnap && this.props.onSnap({ nativeEvent: { ...pt, index } });
  }
}

function addSpring(
  obj: AnimatedObject,
  anchor: AnimatedAdaptableXY<number>,
  tension: Animated.Adaptable<number>,
  dt: Animated.Adaptable<number>,
  influenceArea: Area | undefined,
  behaviors: PrioritizedBehaviorXY[],
) {
  addBehavior(
    {
      priority: 0,
      behavior: influenceXY(
        springObject(obj, {
          anchor,
          tension,
          dt,
        }),
        { x: obj.x, y: obj.y },
        areaToBoundaryXY(influenceArea),
      ),
    },
    behaviors,
  );
}

function addFriction(
  obj: AnimatedObject,
  damping: Animated.Adaptable<number>,
  dt: Animated.Adaptable<number>,
  influenceArea: Area | undefined,
  behaviors: PrioritizedBehaviorXY[],
) {
  addBehavior(
    {
      priority: 1,
      behavior: influenceXY(
        frictionObject(obj, {
          damping,
          dt,
        }),
        { x: obj.x, y: obj.y },
        areaToBoundaryXY(influenceArea),
      ),
    },
    behaviors,
  );
}

function addGravity(
  obj: AnimatedObject,
  anchor: AnimatedAdaptableXY<number>,
  strength: Animated.Adaptable<number>,
  falloff: Animated.Adaptable<number>,
  dt: Animated.Adaptable<number>,
  influenceArea: Area | undefined,
  behaviors: PrioritizedBehaviorXY[],
) {
  addBehavior(
    {
      priority: 0,
      behavior: influenceXY(
        gravityObject(obj, {
          anchor,
          strength,
          falloff,
          dt,
        }),
        { x: obj.x, y: obj.y },
        areaToBoundaryXY(influenceArea),
      ),
    },
    behaviors,
  );
}

function addBehavior(
  behavior: PrioritizedBehaviorXY,
  behaviors: PrioritizedBehaviorXY[],
) {
  let idx = 0;
  while (
    idx < behaviors.length &&
    behaviors[idx].priority < behavior.priority
  ) {
    ++idx;
  }
  behaviors.splice(idx, 0, behavior);
}

function mergeBehaviors(
  temp: PrioritizedBehaviorXY[],
  perm: PrioritizedBehaviorXY[],
): BehaviorXY[] {
  let priority = perm.length
    ? perm[0].priority
    : temp.length
    ? temp[0].priority
    : -1;
  const behaviors: BehaviorXY[] = [];

  let tempIdx = 0;
  let permIdx = 0;

  while (tempIdx < temp.length || permIdx < perm.length) {
    while (tempIdx < temp.length && temp[tempIdx].priority <= priority) {
      behaviors.push(temp[tempIdx].behavior);
      tempIdx++;
    }
    while (permIdx < perm.length && perm[permIdx].priority <= priority) {
      behaviors.push(perm[permIdx].behavior);
      permIdx++;
    }
    priority++;
  }

  return behaviors;
}

function unzipBehaviors(behaviors: BehaviorXY[]): BehaviorsXY {
  const behaviorsXY: BehaviorsXY = { x: [], y: [] };
  for (let behavior of behaviors) {
    behaviorsXY.x.push(behavior.x);
    behaviorsXY.y.push(behavior.y);
  }
  return behaviorsXY;
}

function snapTo(
  target: AnimatedNodeXY<number>,
  snapPoints: SnapPoint[],
  snapPoint: AnimatedSnapPoint,
  clb?: SnapCallback,
  dragClb?: DragCallback,
): Animated.Node<number>[] {
  const dist = new Value(0);

  const snapDist = (pt: SnapPoint) =>
    add(
      sq(sub(target.x, pt.x || DEFAULT.snapPoint.x)),
      sq(sub(target.y, pt.y || DEFAULT.snapPoint.y)),
    );

  const setSnapPoint = (pt: SnapPoint) => [
    set(snapPoint.tension, pt.tension || DEFAULT.snapPoint.tension),
    set(snapPoint.damping, pt.damping || DEFAULT.snapPoint.damping),
    set(snapPoint.x, pt.x || DEFAULT.snapPoint.x),
    set(snapPoint.y, pt.y || DEFAULT.snapPoint.y),
  ];

  const handleSnapTo = [
    set(dist, snapDist(snapPoints[0])),
    ...setSnapPoint(snapPoints[0]),
    ...snapPoints.map((pt) => {
      const newDist = snapDist(pt);
      return cond(lessThan(newDist, dist), [
        set(dist, newDist),
        ...setSnapPoint(pt),
      ]);
    }),
  ];

  if (clb || dragClb) {
    handleSnapTo.push(
      call([snapPoint.x, snapPoint.y, target.x, target.y], ([bx, by, x, y]) => {
        snapPoints.forEach((pt, index) => {
          if (
            (pt.x === undefined || pt.x === bx) &&
            (pt.y === undefined || pt.y === by)
          ) {
            clb && clb({ nativeEvent: { ...pt, index } });
            dragClb &&
              dragClb({
                nativeEvent: { x, y, targetSnapPointId: pt.id, state: "end" },
              });
          }
        });
      }),
    );
  }

  return handleSnapTo;
}

function influenceAreaFromRadius(point: Partial<Point>, radius: number): Area {
  return {
    left: (point.x || 0) - radius,
    right: (point.x || 0) + radius,
    top: (point.y || 0) - radius,
    bottom: (point.y || 0) + radius,
  };
}

function areaToBoundaryXY(area?: Area): BoundaryXY | undefined {
  if (!area) {
    return;
  }

  let boundary: BoundaryXY | undefined = undefined;

  if (area.left !== undefined) {
    boundary = boundary || {};
    boundary.min = boundary.min || {};
    boundary.min.x = area.left;
  }

  if (area.right !== undefined) {
    boundary = boundary || {};
    boundary.max = boundary.max || {};
    boundary.max.x = area.right;
  }

  if (area.top !== undefined) {
    boundary = boundary || {};
    boundary.min = boundary.min || {};
    boundary.min.y = area.top;
  }

  if (area.bottom !== undefined) {
    boundary = boundary || {};
    boundary.max = boundary.max || {};
    boundary.max.y = area.bottom;
  }

  return boundary;
}
