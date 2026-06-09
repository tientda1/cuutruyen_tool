const { MultiSelect } = require('enquirer');
const chalk = require('chalk');

async function test() {
  const choices = [];
  for (let i = 0; i < 5; i++) {
    choices.push({
      name: String(i),
      message: `${i+1}. Chapter ${i+1} ${i % 2 === 0 ? chalk.green('✓') : ''}`,
      enabled: true // Testing if 'enabled' breaks it
    });
  }
  
  try {
    const picked = await new MultiSelect({
      name: 'chapters',
      message: 'Chọn chapter (Space để chọn, Enter để xác nhận):',
      choices,
      limit: 20
    }).run();
    console.log("Picked:", picked);
  } catch(e) {
    console.error(e);
  }
}

test();
