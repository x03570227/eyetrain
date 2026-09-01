# 背景
当前项目是一个空项目，还没有任何文件添加，接下来我们交付设计一个用来每天记录视力及训练视力的工作台，相关的设计与页面功能我将在下面详细说明，你按要求来实现

# 数据库设计

数据库采用本地轻量数据库设计，使用 sqllite ，表结构如下：
```sql
CREATE TABLE IF NOT EXISTS vision_train_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_date DATE NOT NULL UNIQUE COMMENT '记录日期，同一天只允许一条记录',
    -- 训前视力（小数视力，如0.6、1.0；如果用对数视力可备注调整）
    pre_left REAL COMMENT '训前左眼视力',
    pre_right REAL COMMENT '训前右眼视力',
    pre_both REAL COMMENT '训前双眼视力',
    -- 强化训练视力
    train_left REAL COMMENT '强化左眼视力',
    train_right REAL COMMENT '强化右眼视力',
    train_both REAL COMMENT '强化双眼视力',
    -- 距离 单位：cm
    test_distance INTEGER COMMENT '测视距离(cm)',
    train_distance INTEGER COMMENT '强化训练距离(cm)',
    remark TEXT COMMENT '备注，比如训练时长、孩子配合情况、特殊说明',
    gmt_created DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    gmt_modified DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '修改时间'
);

-- 触发器：更新时自动刷新gmt_modified
CREATE TRIGGER IF NOT EXISTS update_vision_train_modtime
AFTER UPDATE ON vision_train_record
FOR EACH ROW
BEGIN
    UPDATE vision_train_record SET gmt_modified = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
```

# 技术和初始化要求

1. 数据库采用 SQL Lite，页面采用静态页面，使用 JS 直接连接 SQL Lite，这样不需要额外运行服务端，本地直接打开页面就可以用了。
2. 首次加载页面时没有任何数据和表，**自动建库建表**，不需要任何初始化步骤，可直接开始使用；只在首次打开时弹一次说明页，讲清数据存在哪儿、怎么备份。
3. 数据库**不存在磁盘上的文件里**：sql.js 在内存里跑，整个库以二进制快照存进浏览器 IndexedDB，每次改动即时写入，刷新和重开浏览器都不丢。
4. 跨设备搬移数据只能靠顶栏的「导出备份 / 导入」：导出会下载一个带日期的 eyerecord 文件，导入时选中它即可。

> 为什么不用「选目录 + 写回本地文件」（File System Access API）：
> `file://` 协议下页面的源是 null（不透明源），FSA / OPFS 会被浏览器硬性禁用，调用直接抛 SecurityError，
> 双击打开 html 时根本用不了。IndexedDB 在 `file://` 下可用，但 Chrome 是按 **html 文件所在的目录**做分区存储的，
> 所以把 index.html 挪到别的文件夹，记录会像消失一样（挪回来就又有了）—— 这一点必须在首次说明页里告诉用户。
> 另外，IndexedDB 里那份是唯一副本，清理浏览器数据会连记录一起清掉，所以「导出备份」必须是显眼可点的动作。

> 注意，如果有不可行的地方，你在计划阶段就跟我说清楚

# 页面功能设计

页面设计成一个简单的工作台，顶部是菜单，主要有两个菜单，一个是当天记录，一个是历史记录

**当天记录**
默认打开页面就是当天记录，其页面就是一个表单，默认展示当天数据表单，如果当天还没有数据，就留空，保存时添加当天数据，否则展示当天数据内容，变更可以更新（通过变更按钮更新），这里表单内容倒是不麻烦，但是因为用户对计算机不是很熟悉，在设计时，务必使页面容易使用，输入框相对大一些（毕竟就两组数据），数值类的，允许按上下来改变大小，一般视图都是 0.2-1.5 之间，上下按钮每点一下就是加减 0.1 的样子。测量距离，数据库设计时存的单位是厘米，但展示时，应用米作为单位，保留2位小数，这样保存时，乘100就是厘米了
表单中备注也要有，放最下面就可以了

当然这个页面顶部，还是需要有一个时间选择，选择哪天，就加载哪天的数据，如果没有就表示当天数据不存在，表单为空，点击保存时，添加新数据，否则展示数据，也允许变更数据，点击保存时更新数据。

**历史记录**

历史记录页面主要分三部分，最上面为筛选条件，由日期选择框（范围选择，后面跟快捷选择，近7天，近30天，默认近30天）构成，改变日期直接触发数据刷新

中间为图表，指定筛选时间范围内的三组图表，分别是：左眼（分训练前、强化后），右眼（训练前、强化后），双眼（训练前、强化后），都是拆线图，横轴为日期，纵轴为视力数值

最底下为指定时间范围内的数据表格，按记录时间，倒序排列

页面样式，尽量要大气一点，美观一点，容易操作


你试一下帮我写一个这样的HTML页面