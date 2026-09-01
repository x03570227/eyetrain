# 背景

当前项目实现了一个单页面HTML，用于记录视力测试和训练的结果，但这个测试需要手工去填写，相对比较麻烦，未来期望能够在训练过程中去记录，而不用特地记录，我们目前的工作目标就是增加视力测试和训练能力

# 调整目标

## 数据库调整
为了适应多用户的情况，在现在数据库的基础上，需要增加一个表用来管理用户信息及配置信息，同时在记录表里，增加用户信息

主要的变更如下：
```sql

CREATE TABLE IF NOT EXISTS user_config (
    -- 主键（自增ID）
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- 用户信息
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    
    -- 配置项
    display_mode INTEGER NOT NULL DEFAULT 0,          -- 展示方式：0-N
    effect_confirm TEXT NOT NULL CHECK (effect_confirm IN ('GAME', 'COLOR')),  -- 效果确认
    enhance_count INTEGER NOT NULL DEFAULT 0,         -- 强化次数：0-N
    record_require TEXT NOT NULL CHECK (record_require IN ('BEST', 'LAST')),  -- 记录要求
    chart_calibration INTEGER NOT NULL DEFAULT 100,   -- 图表校准：默认100
    max_display_count INTEGER NOT NULL DEFAULT 1 CHECK (max_display_count >= 1), -- 最多展示个数：1-N
    
    -- 时间戳
    gmt_created DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    gmt_modified DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '修改时间'
    
    -- 备注
    remark TEXT,
    
    -- 索引（提高查询效率）
    UNIQUE(user_id)  -- 如果每个用户只有一条配置，可以加唯一约束
);

CREATE TRIGGER IF NOT EXISTS update_user_config_modtime
AFTER UPDATE ON user_config
FOR EACH ROW
BEGIN
    UPDATE user_config SET gmt_modified = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

-- 原 vision_train_record 表需要增加一些字段，用来记录秒视的结果（这里我只写字段，未写SQL），完整的表结构如下：

-- 关联用户
-- user_id TEXT NOT NULL,

-- 强化训练视力
-- second_left REAL COMMENT '秒视左眼视力',
-- second_right REAL COMMENT '秒视右眼视力',
-- second_both REAL COMMENT '秒视双眼视力',


CREATE TABLE IF NOT EXISTS vision_train_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL COMMENT '关联用户ID',
    record_date DATE NOT NULL UNIQUE COMMENT '记录日期，同一天只允许一条记录',
    -- 训前视力（小数视力，如0.6、1.0；如果用对数视力可备注调整）
    pre_left REAL COMMENT '训前左眼视力',
    pre_right REAL COMMENT '训前右眼视力',
    pre_both REAL COMMENT '训前双眼视力',
    -- 强化训练视力
    train_left REAL COMMENT '强化左眼视力',
    train_right REAL COMMENT '强化右眼视力',
    train_both REAL COMMENT '强化双眼视力',
	-- 强化训练视力
	second_left REAL COMMENT '秒视左眼视力',
	second_right REAL COMMENT '秒视右眼视力',
	second_both REAL COMMENT '秒视双眼视力',
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

## 支持用户切换

当前单页面并没有用户信息，只是做了个记录，但后面需要支持多用户使用，所以页面展示的内容都需要与用户关联，具体页面及功能调整如下：

新增切换菜单，在导航栏右上角，数据库连接状态前，展示当前用户姓名，如果当前没有用户信息，则此处展示为"切换用户"字样，点击弹出对话框，允许填写姓名
  - 当用户填写好姓名，并点击保存，此时需要先按姓名查一下数据库里是否存在这个用户，如果存在，则直接加载用户的各项配置信息，若不存在，则创建用户信息（配置全用默认值）并加载默认配置
  - 保存成功后，切换用户处展示切换用户的姓名，而填写信息也要按用户ID刷新，包括历史记录
  - 用户ID为系统自动生成，保证唯一性，用纯数字生成的字符串，80打头，日期时间12位，再加6位随机数，例如：8020260831000001


## 增加测训功能

**视力测试例子**
在开始实现视力测试和训练之前，你需要仔细阅读一下  `ai/eye-chart-5m.html`  文件，这个文件是一个标准的视力测试图，上面的功能都能够满足视力测试的需要，但是不够方便，所以我们需要做新的功能将测视，训练，以及保存结果联合起来，但是不管怎么做，测试图标的绘制，功能校准设置等，都与这个HTML是一样的，需要将这个HTML的部分功能搬到我们现在的页面上来。


**测训实现**

在导航菜单中，增加测训菜单，表示在此进行视力测试和训练，点击菜单，页面首先展示的是设置和校准功能，其结构如下：
  - 先展示校准条（要参考 `ai/eye-chart-5m.html` ），也就是一个横条，因为我们这是一个专门的测试页面，所以就不需要像测试页面一样，搞到左上角，但也要注意，校准条的颜色
  - 其次展示设置内容，主要有：
    - 图标个数（即一次最多展示几个，0-8，这里虽然是0到N，但实际上有些图标比较大，我们最多展示一行，N是最大值）
    - 确认效果 effect_confirm：（即用户点击方向键时，首先的核对效果，现在就两项：游戏效果和颜色效果，分别对应 GAME 和 COLOR 值）
    - 强化次数 enhance_count：（表示要成功确认几次，才算这个档训练通过，默认是4次，用户可以改）
    - 记录时机 record_require：（表示用户在训练或强化时，若正确回答了，该如何记录的问题，这个在后面实现中会再详细讲）
    - 图表校准（用户可能在不同电脑下打开，图形大小需要重新校准，也就是自行测量校准条后记录下来的值）。
    以上这些设置值，用户在调整时，每次变化都实时更新到数据库里，要根据当前选中的用户id来更新
  - 最底下为开始测试的按钮，按钮分两组组合选择，第一组是测视、训练、秒视，第二组是左、右、双眼，都用TAB来展示，但是按钮可以小一点，然后下面是开始测试的按钮

**视力测试和训练**

当用户点击 开始训练 时，页面要有个小动画，将所有内容隐藏掉，从第一档0.1开始展示图标，这里要注意展示的方式要根据配置来，下面我将就测试的页面展示以及配置对应关系，一一说明

**初始打开状态**
首先，当打开训练页面时，要隐去其他无关元素，或者说在上面生成一个遮罩（白底），然后展示测试图标，测试图标最多展示几个，要按照配置项中，图标个数来展示，当然图标越大，一个屏蔽能展示的越少，这里要注意下，不要展示太多，导致换行。
- 图标需要居中展示（上下，左右都是居中）
- 若图标展示数量大于1，则需要在随机在一个图标下方，展示向上的红色实心圆点，表示选中状态，指向图标（其实在实现时每个图标都要有这个圆点，只是选中的颜色是红色的，其他的颜色与底色一样，这样可能更容易实现）
- 在测试页面展示后，需要直接将页面设置为全屏
- 全屏情况下，鼠标移到顶部，自动下拉一个浮动条，展示当前选中的训练方式以及眼睛，即开始训练前选择的两组选项的内容，测视、训练、秒视 / 左、右、双眼（选项都展示，可以直接切换测视的方式和眼睛），以及后面一个退出训练的按钮，而同时左侧出现浮动条（坚条）展示当前视力档位信息（比如 0.1 4.0 之类的，具体有哪些值，你可以参考 `ai/eye-chart-5m.html`，你的测试档，也要按照 `ai/eye-chart-5m.html` 中的标准，一档一档，从大图标往小图标去变化）

**测试阶段**
测试阶段，图标正常展示，此时，要根据配置来进行行为处理，同时要监听一些键盘按键，表示用户当前的判断

1. 如果当前测试类型是：秒视，那么每一组图标均只展示3秒，之后就随机重新展示下一组图标
2. 图标展示期间，若监听到用户按（上、下、左、右），这四个方向按钮，则需要匹配用户按钮方向与图标方向是否一致（图标类似山字，口的朝向正好四个方向）
    - 若方向按钮与当前图标方向一致
        - 则记一次当前档位识别成功次数加1
        - 检查 记录时机（record_require）配置项的值，若为BEST，则在更新时，增加一个条件，所更新的值，要大于数据库里已更新的值（当然用户当天首次使用时，并没有记录，需要初始化一下视力测试记录，相应的值全为0即可），若为LAST，则直接更新就可以。
        > 这里要注意，在更新视力值时，因为数据库里是一天一行记录，一行记录里有多个字段，分别对应了不同维度的值，你需要按照以后面的照表来识别更新字段（也可以在代码里将对照表配置写下来）
        - 还要根据 确认效果（effect_confirm）配置的值，来展示成功效果，若为GAME值，则在图标上方产生一个爱心向上飘的效果，若为COLOR，则背景颜色闪一下，用绿色来闪
        - 在成功效果结束后，需要检查该档位的成功次数，是否 > 强化次数(enhance_count)配置的值，若大于，则下一组图标的展示需要前进一档（比如当前是0.1的档，下一组就要0.2的档，当然每一档不都是+0.1，你需要参考 `ai/eye-chart-5m.html` 的档），否则随机更新当档的图标（若一次展示多个，也要随机更新红点）
    - 若方向按钮与当前图标方向不一致，这就表示用户识别错了
        - 此时表示用户没有真正看清图票，需要根据 确认效果（effect_confirm）配置的值，来展示失败效果，若为GAME值，则在图标上方产生一个炸弹爆炸效果，若为COLOR，则背景颜色闪一下，用红色来闪
        - 效果结束后再随机重新展示当前档的图标和选中红点

除上、下、左、右四个按钮的事件监听外，还需要监听一些特殊的按钮事件
- 双击"下"：表示跳过当前档位，直接切换到下一档的图标
- 双击"上"：表示切换回上一档的图标
- 双击"左"：表示切换测试的方式，按照测视、训练、秒视，这样循环切换，比如当前是训练，双击"左"，切换到测视，再双击"左"，切换到秒视，再双击"左"，则又切换回训练，以此循环
- 双击"右"：表示切换训练的眼睛，按照左、右、双眼，这样循环切换，比如当前是右，则双击"右"，切换到双眼，再双击"右"，切换到左，再双击"右"，则又切换回右，以此循环

以上双击事件，在切换测试方式和训练眼睛的过程中，需要重置图标档位，并重新绘制图标，默认都从0.1最大图标开始绘制

__对照表__

-- 训前视力
测视+左=pre_left
测视+右=pre_right
测视+双眼=pre_both
-- 强化训练视力
训练+左=train_left
训练+右=train_right
训练+双眼=train_both
-- 秒视视力测试
秒视+左=second_left
秒视+右=second_right
秒视+双眼=second_both

## 旧功能调整
因为增加了秒视的记录，所以在旧功能里，也要做相应的调整

**手动记录**
手动记录页，目前还没有秒视信息的记录，在 强化训练视力 卡片下方，增加秒视记录卡片

**历史记录**
历史记录页，图表需要增加秒视拆线图，同时调整整个页面的宽度到100%，这样三个图表卡片也会相对宽一点

当然下方表格也要增加相应的字段展示

**初始化**
在连接数据库，初始化时，要改成初始化两个表的结构，而不要再用原来一个表的结构。