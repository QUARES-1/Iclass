export const functionBodies=[
  'int evaluate(int x) {\n'+Array.from({length:13},(_,i)=>'    // 讲解步骤 '+(i+1)+'：保持缩进与完整代码\n').join('')+'    return x * 7;\n}\n',
  'int main() {\n    // <script>throw new Error("代码不应执行")</script>\n    int x = 2;\n    if (x < 3 && x >= 1) {\n        std::cout << evaluate(x) << "\\n";\n    }\n    return 0;\n}\n',
];
export const codeFixture='#include <iostream>\n\n'+functionBodies.join('\n');
