import { AbstractLayout, GraphData } from '@antv/g6-core';
import { Layout } from '../../layout';
import LayoutWorker from '../../layout/worker/layout.worker';
import { LAYOUT_MESSAGE } from '../../layout/worker/layoutConst';
import { gpuDetector } from '../../util/gpu';
import { mix } from '@antv/util';

import { IGraph } from '../../interface/graph';

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const mockRaf = (cb: TimerHandler) => setTimeout(cb, 16);
const mockCaf = (reqId: number) => clearTimeout(reqId);

const helper = {
  // pollyfill
  requestAnimationFrame(callback: FrameRequestCallback) {
    const fn =
      typeof window !== 'undefined'
        ? window.requestAnimationFrame || window.webkitRequestAnimationFrame || mockRaf
        : mockRaf;
    return fn(callback);
  },
  cancelAnimationFrame(requestId: number) {
    const fn =
      typeof window !== 'undefined'
        ? window.cancelAnimationFrame || window.webkitCancelAnimationFrame || mockCaf
        : mockCaf;
    return fn(requestId);
  },
};

const GPULayoutNames = ['fruchterman', 'gForce'];
export default class LayoutController extends AbstractLayout {
  public graph: IGraph;

  public destroyed: boolean;

  private worker;

  private workerData;

  // private data;

  private isGPU: boolean;

  // the configurations of the layout
  // private layoutCfg: any; // LayoutOptions

  // the type name of the layout
  // private layoutType: string;

  // private data: GraphData;

  // private layoutMethod: typeof Layout;

  constructor(graph: IGraph) {
    super(graph);
    this.graph = graph;
    this.layoutCfg = graph.get('layout') || {};
    this.layoutType = this.layoutCfg.type;
    this.worker = null;
    this.workerData = {};
    this.initLayout();
  }

  // eslint-disable-next-line class-methods-use-this
  protected initLayout() {
    // no data before rendering
  }

  // get layout worker and create one if not exists
  private getWorker() {
    if (this.worker) {
      return this.worker;
    }

    if (typeof Worker === 'undefined') {
      // 如果当前浏览器不支持 web worker，则不使用 web worker
      console.warn('Web worker is not supported in current browser.');
      this.worker = null;
    } else {
      this.worker = new LayoutWorker();
    }
    return this.worker;
  }

  // stop layout worker
  private stopWorker() {
    const { workerData } = this;

    if (!this.worker) {
      return;
    }

    this.worker.terminate();
    this.worker = null;
    // 重新开始新的布局之前，先取消之前布局的requestAnimationFrame。
    if (workerData.requestId) {
      helper.cancelAnimationFrame(workerData.requestId);
      workerData.requestId = null;
    }
    if (workerData.requestId2) {
      helper.cancelAnimationFrame(workerData.requestId2);
      workerData.requestId2 = null;
    }
  }

  /**
   * @param {function} success callback
   * @return {boolean} 是否使用web worker布局
   */
  public layout(success?: () => void): boolean {
    const { graph } = this;

    this.data = this.setDataFromGraph();
    const { nodes } = this.data;

    if (!nodes) {
      return false;
    }
    const width = graph.get('width');
    const height = graph.get('height');
    const layoutCfg: any = {};
    Object.assign(
      layoutCfg,
      {
        width,
        height,
        center: [width / 2, height / 2],
      },
      this.layoutCfg,
    );
    this.layoutCfg = layoutCfg;

    const hasLayoutType = !!this.layoutType;

    let { layoutMethod } = this;
    if (layoutMethod) {
      layoutMethod.destroy();
    }

    graph.emit('beforelayout');
    const allHavePos = this.initPositions(layoutCfg.center, nodes);

    let layoutType = this.layoutType;
    let isGPU = false;

    // 防止用户直接用 -gpu 结尾指定布局
    if (layoutType && layoutType.split('-')[1] === 'gpu') {
      layoutType = layoutType.split('-')[0];
      layoutCfg.gpuEnabled = true;
    }

    // 若用户指定开启 gpu，且当前浏览器支持 webgl，且该算法存在 GPU 版本（目前仅支持 fruchterman 和 gForce），使用 gpu 版本的布局
    if (layoutType && layoutCfg.gpuEnabled) {
      let enableGPU = true;
      // 打开下面语句将会导致 webworker 报找不到 window
      if (!gpuDetector().webgl) {
        console.warn(`Your browser does not support webGL or GPGPU. The layout will run in CPU.`);
        enableGPU = false;
      }
      if (!this.hasGPUVersion(layoutType)) {
        console.warn(
          `The '${layoutType}' layout does not support GPU calculation for now, it will run in CPU.`,
        );
        enableGPU = false;
      }
      if (enableGPU) {
        layoutType = `${layoutType}-gpu`;
        // layoutCfg.canvasEl = this.graph.get('canvas').get('el');
        isGPU = true;
      }
    }
    this.isGPU = isGPU;

    this.stopWorker();
    if (layoutCfg.workerEnabled && this.layoutWithWorker(this.data, success)) {
      // 如果启用布局web worker并且浏览器支持web worker，用web worker布局。否则回退到不用web worker布局。
      return true;
    }

    // 所有布局挂载 onLayoutEnd, 在布局结束后依次执行：
    // 执行用户自定义 onLayoutEnd，触发 afterlayout、更新节点位置、fitView/fitCenter、触发 afterrender
    const { onLayoutEnd, layoutEndFormatted } = layoutCfg;
    if (!layoutEndFormatted) {
      layoutCfg.layoutEndFormatted = true;
      layoutCfg.onLayoutEnd = () => {
        // 执行用户自定义 onLayoutEnd
        if (onLayoutEnd) {
          onLayoutEnd();
        }
        // 触发 afterlayout
        graph.emit('afterlayout');
        // 更新节点位置
        this.refreshLayout();
        // 由 graph 传入的，控制 fitView、fitCenter，并触发 afterrender
        success && success();
      };
    }

    if (layoutType === 'force' || layoutType === 'g6force' || layoutType === 'gForce') {
      const { onTick } = layoutCfg;
      const tick = () => {
        if (onTick) {
          onTick();
        }
        graph.refreshPositions();
      };
      layoutCfg.tick = tick;
    } else if (this.layoutType === 'comboForce') {
      layoutCfg.comboTrees = graph.get('comboTrees');
    }

    let enableTick = false;
    if (layoutType !== undefined) {
      try {
        layoutMethod = new Layout[layoutType](layoutCfg);
      } catch (e) {
        console.warn(`The layout method: '${layoutType}' does not exist! Please specify it first.`);
        return false;
      }

      // 是否需要迭代的方式完成布局。这里是来自布局对象的实例属性，是由布局的定义者在布局类定义的。
      enableTick = layoutMethod.enableTick;
      if (enableTick) {
        const { onTick } = layoutCfg;
        const tick = () => {
          if (onTick) {
            onTick();
          }
          graph.refreshPositions();
        };
        layoutMethod.tick = tick;
      }
      layoutMethod.init(this.data);
      // 若存在节点没有位置信息，且没有设置 layout，在 initPositions 中 random 给出了所有节点的位置，不需要再次执行 random 布局
      // 所有节点都有位置信息，且指定了 layout，则执行布局（代表不是第一次进行布局）
      if (hasLayoutType) {
        graph.emit('beginlayout');
        layoutMethod.execute();
        if (layoutMethod.isCustomLayout && layoutCfg.onLayoutEnd) layoutCfg.onLayoutEnd();
      }
      this.layoutMethod = layoutMethod;
    } else if (layoutCfg.onLayoutEnd) {
      // 若没有配置 layout，也需要更新画布
      layoutCfg.onLayoutEnd();
    }
    return false;
  }

  /**
   * layout with web worker
   * @param {object} data graph data
   * @param {function} success callback function
   * @return {boolean} 是否支持web worker
   */
  private layoutWithWorker(data, success?: () => void): boolean {
    const { nodes, edges } = data;
    const { layoutCfg, graph, isGPU } = this;
    const worker = this.getWorker();
    // 每次worker message event handler调用之间的共享数据，会被修改。
    const { workerData } = this;

    if (!worker) {
      return false;
    }

    workerData.requestId = null;
    workerData.requestId2 = null;
    workerData.currentTick = null;
    workerData.currentTickData = null;

    graph.emit('beforelayout');

    const offScreenCanvas = document.createElement('canvas');
    const gpuWorkerAbility =
      isGPU &&
      typeof window !== 'undefined' &&
      // eslint-disable-next-line @typescript-eslint/dot-notation
      window.navigator &&
      !navigator[`gpu`] && // WebGPU 还不支持 OffscreenCanvas
      'OffscreenCanvas' in window &&
      'transferControlToOffscreen' in offScreenCanvas;

    // NOTE: postMessage的message参数里面不能包含函数，否则postMessage会报错，
    // 例如：'function could not be cloned'。
    // 详情参考：https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
    // 所以这里需要把过滤layoutCfg里的函数字段过滤掉。
    const filteredLayoutCfg = filterObject(layoutCfg, (value) => typeof value !== 'function');
    if (!gpuWorkerAbility) {
      worker.postMessage({ type: LAYOUT_MESSAGE.RUN, nodes, edges, layoutCfg: filteredLayoutCfg });
    } else {
      const offscreen: any = (offScreenCanvas as any).transferControlToOffscreen();
      // filteredLayoutCfg.canvas = offscreen;
      filteredLayoutCfg.type = `${filteredLayoutCfg.type}-gpu`;
      worker.postMessage(
        {
          type: LAYOUT_MESSAGE.GPURUN,
          nodes,
          edges,
          layoutCfg: filteredLayoutCfg,
          canvas: offscreen,
        },
        [offscreen],
      );
    }
    worker.onmessage = (event) => {
      this.handleWorkerMessage(event, data, success);
    };
    return true;
  }

  // success callback will be called when updating graph positions for the first time.
  private handleWorkerMessage(event, data, success?: () => void) {
    const { graph, workerData, layoutCfg } = this;
    const eventData = event.data;
    const { type } = eventData;
    const onTick = () => {
      if (layoutCfg.onTick) {
        layoutCfg.onTick();
      }
    };
    const onLayoutEnd = () => {
      if (layoutCfg.onLayoutEnd) {
        layoutCfg.onLayoutEnd();
      }
      graph.emit('afterlayout');
    };

    switch (type) {
      case LAYOUT_MESSAGE.TICK:
        workerData.currentTick = eventData.currentTick;
        workerData.currentTickData = eventData;
        if (!workerData.requestId) {
          workerData.requestId = helper.requestAnimationFrame(function requestId() {
            updateLayoutPosition(data, eventData);
            graph.refreshPositions();
            onTick();
            if (eventData.currentTick === 1 && success) {
              success();
            }

            if (eventData.currentTick === eventData.totalTicks) {
              // 如果是最后一次tick
              onLayoutEnd();
            } else if (workerData.currentTick === eventData.totalTicks) {
              // 注意这里workerData.currentTick可能已经不再是前面赋值时候的值了，
              // 因为在requestAnimationFrame等待时间里，可能产生新的tick。
              // 如果当前tick不是最后一次tick，并且所有的tick消息都已发出来了，那么需要用最后一次tick的数据再刷新一次。
              workerData.requestId2 = helper.requestAnimationFrame(function requestId2() {
                updateLayoutPosition(data, workerData.currentTickData);
                graph.refreshPositions();
                workerData.requestId2 = null;
                onTick();
                onLayoutEnd();
              });
            }
            workerData.requestId = null;
          });
        }
        break;
      case LAYOUT_MESSAGE.END:
        // 如果没有tick消息（非力导布局）
        if (workerData.currentTick == null) {
          updateLayoutPosition(data, eventData);
          this.refreshLayout();
          // 非力导布局，没有tick消息，只有end消息，所以需要执行一次回调。
          if (success) {
            success();
          }
          graph.emit('afterlayout');
        }
        break;
      case LAYOUT_MESSAGE.GPUEND:
        // 如果没有tick消息（非力导布局）
        if (workerData.currentTick == null) {
          updateGPUWorkerLayoutPosition(data, eventData);
          this.refreshLayout();
          // 非力导布局，没有tick消息，只有end消息，所以需要执行一次回调。
          if (success) {
            success();
          }
          graph.emit('afterlayout');
        }
        break;
      case LAYOUT_MESSAGE.ERROR:
        console.warn('Web-Worker layout error!', eventData.message);
        break;
      default:
        break;
    }
  }

  // 更新布局参数
  public updateLayoutCfg(cfg) {
    const { graph, layoutMethod, layoutType, layoutCfg } = this;

    this.layoutType = cfg.type;
    if (!layoutMethod || layoutMethod.destroyed) {
      this.layoutCfg = mix({}, layoutCfg, cfg);
      this.layout();
      return;
    }
    this.data = this.setDataFromGraph();

    this.stopWorker();
    if (cfg.workerEnabled && this.layoutWithWorker(this.data, null)) {
      // 如果启用布局web worker并且浏览器支持web worker，用web worker布局。否则回退到不用web worker布局。
      return;
    }

    layoutMethod.init(this.data);
    layoutMethod.updateCfg(cfg);
    graph.emit('beforelayout');
    layoutMethod.execute();

    if (layoutMethod.isCustomLayout && layoutCfg.onLayoutEnd) layoutCfg.onLayoutEnd();
  }

  public hasGPUVersion(layoutName: string): boolean {
    const length = GPULayoutNames.length;
    for (let i = 0; i < length; i++) {
      if (GPULayoutNames[i] === layoutName) return true;
    }
    return false;
  }

  public destroy() {
    const { layoutMethod } = this;
    if (layoutMethod) {
      layoutMethod.destroy();
      layoutMethod.destroyed = true;
    }
    const { worker } = this;
    if (worker) {
      worker.terminate();
      this.worker = null;
    }
    this.destroyed = true;

    this.graph.set('layout', undefined);
    this.layoutCfg = undefined;
    this.layoutType = undefined;
    this.layoutMethod = undefined;
    this.graph = null;
  }
}

function updateLayoutPosition(data, layoutData) {
  const { nodes } = data;
  const { nodes: layoutNodes } = layoutData;
  const nodeLength = nodes.length;
  for (let i = 0; i < nodeLength; i++) {
    const node = nodes[i];
    node.x = layoutNodes[i].x;
    node.y = layoutNodes[i].y;
  }
}

function filterObject(collection, callback) {
  const result = {};
  if (collection && typeof collection === 'object') {
    Object.keys(collection).forEach((key) => {
      if (collection.hasOwnProperty(key) && callback(collection[key])) {
        result[key] = collection[key];
      }
    });

    return result;
  }
  return collection;
}

function updateGPUWorkerLayoutPosition(data, layoutData) {
  const { nodes } = data;
  const { vertexEdgeData } = layoutData;
  const nodeLength = nodes.length;
  for (let i = 0; i < nodeLength; i++) {
    const node = nodes[i];
    const x = vertexEdgeData[4 * i];
    const y = vertexEdgeData[4 * i + 1];
    node.x = x;
    node.y = y;
  }
}
